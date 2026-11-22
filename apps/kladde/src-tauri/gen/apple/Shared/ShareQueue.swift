import CryptoKit
import Foundation
import Security

enum ShareFolder: Int32 {
    case inbox = 0
    case clips = 1

    var name: String { self == .inbox ? "Inbox" : "Clips" }

    func context(_ id: String) -> Data {
        Data((self == .inbox ? id : "clip:" + id).utf8)
    }
}

enum ShareQueue {
    static let limit = 64 * 1024 * 1024
    static let maxItems = 32
    static let group = "group.de.kladde.notebook.capture"

    static func directory(_ folder: ShareFolder = .inbox) throws -> URL {
        guard let groupURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw CocoaError(.fileReadNoPermission)
        }
        var dir = groupURL.appendingPathComponent(folder.name, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return dir
    }

    static func key() throws -> SymmetricKey {
        guard let access = Bundle.main.object(forInfoDictionaryKey: "CaptureKeychainGroup") as? String, !access.isEmpty else {
            throw CocoaError(.fileReadNoPermission)
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: group,
            kSecAttrAccount as String: "inbox", kSecAttrAccessGroup as String: access]
        var read = query
        read[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound else { throw CocoaError(.fileReadNoPermission) }
        let newKey = SymmetricKey(size: .bits256)
        var insert = query
        insert[kSecValueData as String] = newKey.withUnsafeBytes { Data($0) }
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let saved = SecItemAdd(insert as CFDictionary, nil)
        if saved == errSecDuplicateItem {
            guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data, data.count == 32 else { throw CocoaError(.fileReadNoPermission) }
            return SymmetricKey(data: data)
        }
        guard saved == errSecSuccess else { throw CocoaError(.fileWriteNoPermission) }
        return newKey
    }

    static func items(_ folder: ShareFolder = .inbox) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory(folder), includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles])
            .filter { UUID(uuidString: $0.lastPathComponent) != nil }
            .sorted { left, right in
                let first = try left.resourceValues(forKeys: [.creationDateKey]).creationDate ?? .distantPast
                let second = try right.resourceValues(forKeys: [.creationDateKey]).creationDate ?? .distantPast
                return first < second
            }
    }

    static func save(name: String, type: String, bytes: Data) throws {
        var payload = try JSONSerialization.data(withJSONObject: ["name": String(name.prefix(200)), "type": type])
        payload.append(0)
        payload.append(bytes)
        try store(payload, in: .inbox, size: bytes.count)
    }

    static func saveClip(_ message: Data) throws {
        try store(message, in: .clips, size: message.count)
    }

    private static func store(_ payload: Data, in folder: ShareFolder, size: Int) throws {
        guard size > 0, size <= limit else { throw CocoaError(.fileReadTooLarge) }
        guard try items(folder).count < maxItems else { throw CocoaError(.fileWriteOutOfSpace) }
        let id = UUID().uuidString.lowercased()
        guard let encrypted = try AES.GCM.seal(payload, using: key(), authenticating: folder.context(id)).combined else {
            throw CocoaError(.fileWriteUnknown)
        }
        try encrypted.write(to: directory(folder).appendingPathComponent(id), options: [.atomic, .completeFileProtection])
    }

    static func load(_ id: UUID, from folder: ShareFolder = .inbox) throws -> Data {
        let name = id.uuidString.lowercased()
        let file = try directory(folder).appendingPathComponent(name)
        let properties = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard properties.isRegularFile == true, properties.isSymbolicLink != true,
              let size = properties.fileSize, size <= limit + 4096 else { throw CocoaError(.fileReadCorruptFile) }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: file)), using: key(), authenticating: folder.context(name))
    }

    static func remove(_ id: UUID, from folder: ShareFolder = .inbox) throws {
        try FileManager.default.removeItem(at: directory(folder).appendingPathComponent(id.uuidString.lowercased()))
    }
}
