import Foundation
import CloudKit

/// 云端这一侧(跨端规则第 12 节):私有数据库、自定义区 `draftback`、四种记录。
/// Mac 只写 ReviewDocument / Attachment / Receipt,只读 AnnotationBatch;手机反过来。
/// 记录名约定:ReviewDocument = docId;Attachment = "att_<docId>_<相对路径校验码前 16 位>";
/// AnnotationBatch = batchId;Receipt = "receipt_<batchId>"。
enum CloudSchema {
    static let containerID = "iCloud.app.draftback"
    static let zoneName = "draftback"
    static let reviewDocument = "ReviewDocument"
    static let attachment = "Attachment"
    static let annotationBatch = "AnnotationBatch"
    static let receipt = "Receipt"
    static func receiptName(batchId: String) -> String { "receipt_\(batchId)" }
    static func attachmentName(docId: String, relPath: String) -> String { "att_\(docId)_\(Hashing.sha256(relPath).prefix(16))" }
}

final class CloudStore {
    let container: CKContainer
    let database: CKDatabase
    let zoneID: CKRecordZone.ID
    private let tokenFile: URL
    private var zoneReady = false

    init(stateDir: URL) {
        container = CKContainer(identifier: CloudSchema.containerID)
        database = container.privateCloudDatabase
        zoneID = CKRecordZone.ID(zoneName: CloudSchema.zoneName, ownerName: CKCurrentUserDefaultName)
        tokenFile = stateDir.appendingPathComponent("zone-change-token")
    }

    func accountStatus() async throws -> CKAccountStatus { try await container.accountStatus() }
    /// 每次写、删云端之前调一下:换号通知到了就抛错停下(跨端规则第 9 节;SyncLoop 设置)
    var guardAccount: (() throws -> Void)?
    /// 当前 iCloud 账号在这个容器里的用户记录名(只拿来算指纹分账号,不外传原文)
    func userRecordName() async throws -> String { try await container.userRecordID().recordName }

    func ensureZone() async throws {
        if zoneReady { return }
        let zone = CKRecordZone(zoneID: zoneID)
        _ = try await database.modifyRecordZones(saving: [zone], deleting: [])
        zoneReady = true
    }

    /// 区在云端没了(新容器在控制台第一次打开时会初始化开发环境,之前建的区随之消失;「Reset Environment」也一样):
    /// 清掉"已建区"标记和变更令牌,下一轮 ensureZone 重建。不然进程不重启就一直报「Zone does not exist」
    private func noteZoneLoss(_ error: Error) {
        guard let ck = error as? CKError else { return }
        let codes = [ck.code] + (ck.partialErrorsByItemID?.values.compactMap { ($0 as? CKError)?.code } ?? [])
        if codes.contains(where: { $0 == .zoneNotFound || $0 == .userDeletedZone }) {
            zoneReady = false
            clearToken()
        }
    }

    func recordID(_ name: String) -> CKRecord.ID { CKRecord.ID(recordName: name, zoneID: zoneID) }

    func fetch(_ names: [String]) async throws -> [String: CKRecord] {
        guard !names.isEmpty else { return [:] }
        let results: [CKRecord.ID: Result<CKRecord, Error>]
        do { results = try await database.records(for: names.map(recordID)) } catch { noteZoneLoss(error); throw error }
        var out: [String: CKRecord] = [:]
        for (id, result) in results {
            switch result {
            case .success(let record): out[id.recordName] = record
            case .failure(let error): noteZoneLoss(error) // 记录不存在是正常的(首次推送),区不存在要记下来
            }
        }
        return out
    }

    /// Mac 是这些记录的唯一写入方,用 allKeys 覆盖,不和自己较劲版本标签
    func save(_ records: [CKRecord]) async throws {
        guard !records.isEmpty else { return }
        try guardAccount?()
        let result: (saveResults: [CKRecord.ID: Result<CKRecord, Error>], deleteResults: [CKRecord.ID: Result<Void, Error>])
        do {
            result = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .allKeys, atomically: true)
        } catch { noteZoneLoss(error); throw error }
        for (id, outcome) in result.saveResults {
            if case .failure(let error) = outcome {
                noteZoneLoss(error)
                throw SyncError.cloud("保存记录 \(id.recordName) 失败: \(error.localizedDescription)")
            }
        }
    }

    /// 条件写入(跨端规则 v2.3 第 12 节「发布先后」):只有"读到之后没人改过"才写;被改过抛 .serverRecordChanged,由调用方重读比较 revision
    func saveIfUnchanged(_ records: [CKRecord]) async throws {
        guard !records.isEmpty else { return }
        try guardAccount?()
        let result: (saveResults: [CKRecord.ID: Result<CKRecord, Error>], deleteResults: [CKRecord.ID: Result<Void, Error>])
        do {
            result = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .ifServerRecordUnchanged, atomically: true)
        } catch { noteZoneLoss(error); throw error }
        for (_, outcome) in result.saveResults {
            if case .failure(let error) = outcome { noteZoneLoss(error); throw error }
        }
    }

    /// 排查用:按记录名删除(main.swift --delete-records)
    func delete(_ names: [String]) async throws {
        guard !names.isEmpty else { return }
        try guardAccount?()
        _ = try await database.modifyRecords(saving: [], deleting: names.map(recordID), savePolicy: .allKeys, atomically: true)
    }

    /// 云端清理用:不要求整批成功(有的记录可能早就没了),记录不存在不算错;每次最多 300 条
    func deleteIgnoringMissing(_ names: [String]) async throws {
        var start = 0
        while start < names.count {
            let chunk = Array(names[start..<min(start + 300, names.count)])
            start += chunk.count
            try guardAccount?()
            let result = try await database.modifyRecords(saving: [], deleting: chunk.map(recordID), savePolicy: .allKeys, atomically: false)
            for (_, outcome) in result.deleteResults {
                if case .failure(let error) = outcome, (error as? CKError)?.code != .unknownItem { throw error }
            }
        }
    }

    // MARK: 增量拉取(服务端变更令牌落盘;处理失败时不推进令牌,下一轮重拉)

    func loadToken() -> CKServerChangeToken? {
        guard let data = try? Data(contentsOf: tokenFile) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }
    func saveToken(_ token: CKServerChangeToken) throws {
        let data = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
        try data.write(to: tokenFile, options: .atomic)
    }
    func clearToken() { try? FileManager.default.removeItem(at: tokenFile) }

    struct ZoneChanges {
        var changed: [CKRecord] = []
        var deleted: [CKRecord.ID] = []
        var token: CKServerChangeToken?
    }

    /// 区里全部记录名(只取记录名,不下载正文与附件):云端清理按「att_<文档标识>_」前缀找出这篇的全部附件,
    /// 包括升级前推过、后来不再引用、台账里没有的旧附件
    func allRecordNames() async throws -> [String] {
        var names: [String] = []
        var cursor: CKServerChangeToken?
        var moreComing = true
        while moreComing {
            let page = try await database.recordZoneChanges(inZoneWith: zoneID, since: cursor, desiredKeys: [], resultsLimit: nil)
            for (id, result) in page.modificationResultsByID { if case .success = result { names.append(id.recordName) } }
            cursor = page.changeToken
            moreComing = page.moreComing
        }
        return names
    }

    func fetchChanges(since token: CKServerChangeToken?) async throws -> ZoneChanges {
        var changes = ZoneChanges()
        var cursor = token
        var moreComing = true
        while moreComing {
            do {
                let page = try await database.recordZoneChanges(inZoneWith: zoneID, since: cursor)
                for (_, result) in page.modificationResultsByID {
                    if case .success(let modification) = result { changes.changed.append(modification.record) }
                }
                changes.deleted.append(contentsOf: page.deletions.map { $0.recordID })
                cursor = page.changeToken
                changes.token = page.changeToken
                moreComing = page.moreComing
            } catch let error as CKError where error.code == .changeTokenExpired {
                clearToken()
                cursor = nil
                changes = ZoneChanges()
            } catch {
                noteZoneLoss(error)
                throw error
            }
        }
        return changes
    }
}

enum SyncError: Error, CustomStringConvertible {
    case cloud(String)
    case payload(String)
    case superseded
    case accountChanged
    var description: String {
        switch self {
        case .accountChanged: return "iCloud 账号刚换了,这一轮停下,下一轮按新账号重来"
        case .cloud(let message): return message
        case .payload(let message): return message
        case .superseded: return "云端已有更新的发布,本次作废"
        }
    }
}

enum Hashing {
    static func sha256(_ data: Data) -> String {
        var hash = [UInt8](repeating: 0, count: 32)
        data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash) }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
    static func sha256(_ text: String) -> String { sha256(Data(text.utf8)) }
}

import CommonCrypto
