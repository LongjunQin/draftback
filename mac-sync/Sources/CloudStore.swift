import Foundation
import CloudKit

/// 云端这一侧(跨端规则第 12 节):私有数据库、自定义区 `mdturn`、四种记录。
/// Mac 只写 ReviewDocument / Attachment / Receipt,只读 AnnotationBatch;手机反过来。
/// 记录名约定:ReviewDocument = docId;Attachment = "att_<docId>_<相对路径校验码前 16 位>";
/// AnnotationBatch = batchId;Receipt = "receipt_<batchId>"。
enum CloudSchema {
    static let containerID = "iCloud.org.mdturn"
    static let zoneName = "mdturn"
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

    func ensureZone() async throws {
        if zoneReady { return }
        let zone = CKRecordZone(zoneID: zoneID)
        _ = try await database.modifyRecordZones(saving: [zone], deleting: [])
        zoneReady = true
    }

    func recordID(_ name: String) -> CKRecord.ID { CKRecord.ID(recordName: name, zoneID: zoneID) }

    func fetch(_ names: [String]) async throws -> [String: CKRecord] {
        guard !names.isEmpty else { return [:] }
        let results = try await database.records(for: names.map(recordID))
        var out: [String: CKRecord] = [:]
        for (id, result) in results {
            if case .success(let record) = result { out[id.recordName] = record }
        }
        return out
    }

    /// Mac 是这些记录的唯一写入方,用 allKeys 覆盖,不和自己较劲版本标签
    func save(_ records: [CKRecord]) async throws {
        guard !records.isEmpty else { return }
        let result = try await database.modifyRecords(saving: records, deleting: [], savePolicy: .allKeys, atomically: true)
        for (id, outcome) in result.saveResults {
            if case .failure(let error) = outcome { throw SyncError.cloud("保存记录 \(id.recordName) 失败: \(error.localizedDescription)") }
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
            }
        }
        return changes
    }
}

enum SyncError: Error, CustomStringConvertible {
    case cloud(String)
    case payload(String)
    var description: String {
        switch self {
        case .cloud(let message): return message
        case .payload(let message): return message
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
