import Foundation
import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// 当前打开的文档(内存态)。
final class OpenedDocument: ObservableObject, Identifiable {
    let id = UUID()
    let url: URL
    let name: String
    let markdown: String
    let hash: String
    let assets: [String: String]      // 相对路径 → data: URL(能读到的同目录图片)
    let securityScoped: Bool
    @Published var notes: [Note]
    @Published var outline: [OutlineItem] = []

    init(url: URL, markdown: String, assets: [String: String], notes: [Note], securityScoped: Bool) {
        self.url = url
        self.name = url.lastPathComponent
        self.markdown = markdown
        self.hash = Hashing.sha256(markdown)
        self.assets = assets
        self.notes = notes
        self.securityScoped = securityScoped
    }

    deinit { if securityScoped { url.stopAccessingSecurityScopedResource() } }

    var openNotes: [Note] { notes.filter { $0.isOpen } }
}

/// 文档库:最近文件(书签)、打开/读取、批注本地持久化(先落盘再说)、批次导出。
@MainActor
final class DocumentStore: ObservableObject {
    @Published var recents: [RecentDocument] = []
    @Published var current: OpenedDocument?
    @Published var lastError: String?
    @Published var pendingShare: URL?

    private let fileManager = FileManager.default
    private var transport: SyncTransport = ExportTransport()

    init() { loadRecents() }

    // MARK: 目录

    /// 用户自己的文档:「文件」App → 我的 iPhone → MDTurn。
    private var documentsDirectory: URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    /// App 内部数据(批注、最近文件)放在 Application Support:随 iCloud 备份,但不出现在「文件」App 里,
    /// 免得被当成普通文件误删误改。
    private var dataDirectory: URL {
        let url = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MDTurn", isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private var annotationsDirectory: URL {
        let url = dataDirectory.appendingPathComponent("annotations", isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private var recentsFile: URL { dataDirectory.appendingPathComponent("recent.json") }

    /// 文档的稳定键。iOS 更新或重装 App 时会换沙盒路径,所以 App 自己的文件夹(Documents)
    /// 和随 App 自带的示例文档用相对路径;iCloud 云盘、其他 App 的文件夹等外部位置用完整路径。
    func documentKey(for url: URL) -> String {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let roots: [(String, URL)] = [("documents", documentsDirectory), ("bundle", Bundle.main.bundleURL)]
        for (label, root) in roots {
            let base = root.standardizedFileURL.resolvingSymlinksInPath().path
            if path.hasPrefix(base + "/") { return "\(label):" + String(path.dropFirst(base.count + 1)) }
        }
        return path
    }

    /// 批注文件按"文档稳定键的 SHA-256"命名,与文档内容版本无关;每条批注自带它所依据的版本指纹。
    private func annotationsFile(for url: URL) -> URL {
        annotationsDirectory.appendingPathComponent("\(Hashing.sha256(documentKey(for: url))).annotations.json")
    }

    // MARK: 最近文件

    private func loadRecents() {
        guard let data = try? Data(contentsOf: recentsFile),
              let items = try? JSONDecoder().decode([RecentDocument].self, from: data) else { return }
        recents = items
    }

    private func saveRecents() {
        if let data = try? JSONEncoder().encode(recents) { try? data.write(to: recentsFile, options: .atomic) }
    }

    private func remember(url: URL) {
        guard let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
        let entry = RecentDocument(id: Hashing.sha256(documentKey(for: url)), name: url.lastPathComponent, bookmark: bookmark,
                                   lastOpenedAt: Date(), directoryHint: url.deletingLastPathComponent().lastPathComponent)
        recents.removeAll { $0.id == entry.id }
        recents.insert(entry, at: 0)
        recents = Array(recents.prefix(30))
        saveRecents()
    }

    func forget(_ recent: RecentDocument) {
        recents.removeAll { $0.id == recent.id }
        saveRecents()
    }

    func open(recent: RecentDocument) {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: recent.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            lastError = "找不到《\(recent.name)》,它可能已被移动或删除。"
            return
        }
        open(url: url, fromExternal: true)
    }

    // MARK: 打开

    /// 打开示例文档(随 App 自带,首次使用与模拟器演示用)。
    func openSample() {
        guard let url = Bundle.main.url(forResource: "示例文档", withExtension: "md") else { lastError = "示例文档缺失。"; return }
        open(url: url, fromExternal: false)
    }

    func open(url: URL, fromExternal: Bool) {
        let scoped = fromExternal && url.startAccessingSecurityScopedResource()
        do {
            let data = try Data(contentsOf: url)
            guard let markdown = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else {
                throw NSError(domain: "MDTurn", code: 1, userInfo: [NSLocalizedDescriptionKey: "文件不是 UTF-8 文本。"])
            }
            let assets = Self.collectAssets(markdown: markdown, around: url)
            let notes = loadNotes(for: url)
            let document = OpenedDocument(url: url, markdown: markdown, assets: assets, notes: notes, securityScoped: scoped)
            if fromExternal { remember(url: url) }
            current = document
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            lastError = "打开失败:\(error.localizedDescription)"
        }
    }

    func close() { current = nil }

    /// 尽力读取文档引用的同目录图片(iOS 对单文件授权通常不含同目录,读不到就留占位,跨端规则第 5 节)。
    private static func collectAssets(markdown: String, around url: URL) -> [String: String] {
        var assets: [String: String] = [:]
        let pattern = #"!\[[^\]]*\]\(([^)\s]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return assets }
        let base = url.deletingLastPathComponent()
        let text = markdown as NSString
        for match in regex.matches(in: markdown, range: NSRange(location: 0, length: text.length)) {
            let rawPath = text.substring(with: match.range(at: 1))
            if rawPath.hasPrefix("http") || rawPath.hasPrefix("data:") { continue }
            let key = rawPath.removingPercentEncoding ?? rawPath
            if assets[key] != nil { continue }
            let fileURL = base.appendingPathComponent(key)
            guard let data = try? Data(contentsOf: fileURL), data.count <= 20 * 1024 * 1024 else { continue }
            let mime: String
            switch fileURL.pathExtension.lowercased() {
            case "png": mime = "image/png"
            case "jpg", "jpeg": mime = "image/jpeg"
            case "gif": mime = "image/gif"
            case "svg": mime = "image/svg+xml"
            case "webp": mime = "image/webp"
            default: continue
            }
            assets[key] = "data:\(mime);base64,\(data.base64EncodedString())"
        }
        return assets
    }

    // MARK: 批注持久化

    private func loadNotes(for url: URL) -> [Note] {
        guard let data = try? Data(contentsOf: annotationsFile(for: url)),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["annotations"] as? [[String: Any]] else { return [] }
        return list.map { Note(raw: $0) }
    }

    private func persistNotes(_ document: OpenedDocument) {
        let object: [String: Any] = [
            "version": 1,
            "document": ["name": document.name, "hash": document.hash],
            "annotations": document.notes.map { $0.raw },
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: annotationsFile(for: document.url), options: .atomic)
    }

    func add(note: Note, to document: OpenedDocument) {
        var raw = note.raw
        raw["baseVersion"] = document.hash
        document.notes.insert(Note(raw: raw), at: 0)
        persistNotes(document)
    }

    func update(noteId: String, comment: String, in document: OpenedDocument) {
        guard let index = document.notes.firstIndex(where: { $0.id == noteId }) else { return }
        document.notes[index].raw["comment"] = comment
        document.notes[index].raw["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        persistNotes(document)
    }

    func remove(noteId: String, from document: OpenedDocument) {
        document.notes.removeAll { $0.id == noteId }
        persistNotes(document)
    }

    // MARK: 完成本轮:打包批次

    func submitBatch(for document: OpenedDocument) {
        let open = document.openNotes
        guard !open.isEmpty else { lastError = "这一轮还没有批注。"; return }
        guard let data = try? JSONSerialization.data(withJSONObject: open.map { $0.raw }),
              let json = String(data: data, encoding: .utf8) else { return }
        let batch = AnnotationBatch(
            batchId: UUID().uuidString.lowercased(), documentName: document.name, baseVersion: document.hash,
            completedAt: ISO8601DateFormatter().string(from: Date()), device: UIDevice.current.name, annotationsJSON: json)
        do {
            pendingShare = try transport.submit(batch: batch)
        } catch {
            lastError = "打包批注失败:\(error.localizedDescription)"
        }
    }

    func sharePDF(_ data: Data, name: String) {
        let url = fileManager.temporaryDirectory.appendingPathComponent(name.replacingOccurrences(of: ".md", with: "") + ".pdf")
        do { try data.write(to: url, options: .atomic); pendingShare = url }
        catch { lastError = "导出 PDF 失败:\(error.localizedDescription)" }
    }
}
