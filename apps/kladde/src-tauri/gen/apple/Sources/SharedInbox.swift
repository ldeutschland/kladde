import Foundation

@_cdecl("kladde_share_read")
func shareRead(_ folder: Int32, _ name: UnsafePointer<CChar>, _ output: UnsafeMutableRawPointer,
               _ copy: @convention(c) (UnsafeMutableRawPointer, UnsafePointer<UInt8>?, Int) -> Void) -> Bool {
    guard let place = ShareFolder(rawValue: folder) else { return false }
    do {
        let id = String(cString: name)
        let data: Data
        if id.isEmpty {
            data = try JSONEncoder().encode(ShareQueue.items(place).map { $0.lastPathComponent })
        } else if let uuid = UUID(uuidString: id) {
            data = try ShareQueue.load(uuid, from: place)
        } else { return false }
        data.withUnsafeBytes { copy(output, $0.bindMemory(to: UInt8.self).baseAddress, $0.count) }
        return true
    } catch { return false }
}

@_cdecl("kladde_share_remove")
func shareRemove(_ folder: Int32, _ name: UnsafePointer<CChar>) -> Bool {
    guard let place = ShareFolder(rawValue: folder), let uuid = UUID(uuidString: String(cString: name)) else { return false }
    do {
        try ShareQueue.remove(uuid, from: place)
        return true
    } catch CocoaError.fileNoSuchFile {
        return true
    } catch { return false }
}
