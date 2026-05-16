import Foundation
import Darwin

// MARK: - Constants

let XATTR_KEY = "com.apple.metadata:_kMDItemUserTags"

let COLOR_TAG_STRINGS: [Int: String] = [
    1: "Gray\n1",
    2: "Green\n2",
    3: "Purple\n3",
    4: "Blue\n4",
    5: "Yellow\n5",
    6: "Red\n6",
    7: "Orange\n7",
]

// MARK: - xattr I/O

func xattrRead(path: String) -> Data? {
    let len = getxattr(path, XATTR_KEY, nil, 0, 0, 0)
    guard len > 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: len)
    let actual = getxattr(path, XATTR_KEY, &buf, len, 0, 0)
    guard actual >= 0 else { return nil }
    return Data(buf[0..<actual])
}

func xattrWrite(path: String, data: Data) -> Bool {
    let result = data.withUnsafeBytes { ptr -> Int32 in
        setxattr(path, XATTR_KEY, ptr.baseAddress, ptr.count, 0, 0)
    }
    return result == 0
}

func xattrDelete(path: String) {
    removexattr(path, XATTR_KEY, 0)
}

// MARK: - bplist reading (port of bplist.ts parseStringArray)

enum BPlistError: Error {
    case unexpectedType(UInt8, Int)
    case invalidFormat
}

func readUIntN(_ data: Data, offset: Int, size: Int) -> UInt64 {
    var val: UInt64 = 0
    for i in 0..<size {
        val = (val << 8) | UInt64(data[offset + i])
    }
    return val
}

func readIntObject(_ data: Data, offset: Int) throws -> (value: Int, totalBytes: Int) {
    let marker = data[offset]
    guard (marker >> 4) == 0x1 else {
        throw BPlistError.unexpectedType(marker, offset)
    }
    let byteSize = 1 << Int(marker & 0xF)
    return (Int(readUIntN(data, offset: offset + 1, size: byteSize)), 1 + byteSize)
}

indirect enum PlistValue {
    case string(String)
    case array([PlistValue])
}

func parseObjectAt(_ data: Data, offset: Int, refSize: Int, offsets: [Int]) throws -> PlistValue {
    let marker = data[offset]
    let high = Int(marker >> 4) & 0xF
    let low  = Int(marker & 0xF)

    // ASCII string (0x5)
    if high == 0x5 {
        var len: Int; var dataOff: Int
        if low == 0xF {
            let (v, c) = try readIntObject(data, offset: offset + 1)
            len = v; dataOff = offset + 1 + c
        } else {
            len = low; dataOff = offset + 1
        }
        let bytes = [UInt8](data[dataOff..<(dataOff + len)])
        return .string(String(bytes: bytes, encoding: .ascii) ?? "")
    }

    // UTF-16BE string (0x6)
    if high == 0x6 {
        var len: Int; var dataOff: Int
        if low == 0xF {
            let (v, c) = try readIntObject(data, offset: offset + 1)
            len = v; dataOff = offset + 1 + c
        } else {
            len = low; dataOff = offset + 1
        }
        var swapped = [UInt8](repeating: 0, count: len * 2)
        for i in stride(from: 0, to: len * 2 - 1, by: 2) {
            swapped[i]     = data[dataOff + i + 1]
            swapped[i + 1] = data[dataOff + i]
        }
        return .string(String(bytes: swapped, encoding: .utf16LittleEndian) ?? "")
    }

    // Array (0xA)
    if high == 0xA {
        var count: Int; var refsOff: Int
        if low == 0xF {
            let (v, c) = try readIntObject(data, offset: offset + 1)
            count = v; refsOff = offset + 1 + c
        } else {
            count = low; refsOff = offset + 1
        }
        var items: [PlistValue] = []
        for i in 0..<count {
            let ref = Int(readUIntN(data, offset: refsOff + i * refSize, size: refSize))
            items.append(try parseObjectAt(data, offset: offsets[ref], refSize: refSize, offsets: offsets))
        }
        return .array(items)
    }

    throw BPlistError.unexpectedType(marker, offset)
}

func parseStringArrayStandard(_ data: Data) -> [String]? {
    guard data.count >= 40 else { return nil }
    let tBase = data.count - 32
    let offsetIntSize = Int(data[tBase + 6])
    let objectRefSize = Int(data[tBase + 7])
    guard offsetIntSize > 0, objectRefSize > 0 else { return nil }

    let numObjects = Int(readUIntN(data, offset: tBase + 8,  size: 8))
    let topObject  = Int(readUIntN(data, offset: tBase + 16, size: 8))
    let offsetTableOffset = Int(readUIntN(data, offset: tBase + 24, size: 8))
    guard numObjects > 0, topObject < numObjects else { return nil }

    var offsets: [Int] = []
    offsets.reserveCapacity(numObjects)
    for i in 0..<numObjects {
        offsets.append(Int(readUIntN(data, offset: offsetTableOffset + i * offsetIntSize, size: offsetIntSize)))
    }
    guard topObject < offsets.count else { return nil }

    guard let root = try? parseObjectAt(data, offset: offsets[topObject], refSize: objectRefSize, offsets: offsets),
          case .array(let items) = root else { return nil }
    return items.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
}

// Minimal format emitted by Finder: magic + inline array + inline strings, no offset table
func parseObjectAtMinimal(_ data: Data, offset: Int) throws -> (PlistValue, Int) {
    let marker = data[offset]
    let high = Int(marker >> 4) & 0xF
    let low  = Int(marker & 0xF)

    if high == 0x5 {
        var len: Int; var consumed: Int
        if low == 0xF {
            let (v, c) = try readIntObject(data, offset: offset + 1)
            len = v; consumed = 1 + c
        } else {
            len = low; consumed = 1
        }
        let bytes = [UInt8](data[(offset + consumed)..<(offset + consumed + len)])
        return (.string(String(bytes: bytes, encoding: .ascii) ?? ""), consumed + len)
    }

    if high == 0xA {
        var count: Int; var consumed: Int
        if low == 0xF {
            let (v, c) = try readIntObject(data, offset: offset + 1)
            count = v; consumed = 1 + c
        } else {
            count = low; consumed = 1
        }
        var refs: [Int] = []
        for i in 0..<count {
            refs.append(Int(data[offset + consumed + i]))
        }
        consumed += count  // refSize = 1 in minimal format

        var objects: [PlistValue] = []
        var pos = offset + consumed
        for _ in 0..<count {
            let (obj, objConsumed) = try parseObjectAtMinimal(data, offset: pos)
            objects.append(obj)
            pos += objConsumed
        }

        // Global ref index 0 = array itself; 1..n = the string objects
        let firstObjectIndex = 1
        var result: [PlistValue] = []
        for ref in refs {
            let localIdx = ref - firstObjectIndex
            if localIdx >= 0 && localIdx < objects.count {
                result.append(objects[localIdx])
            }
        }
        return (.array(result), pos - offset)
    }

    throw BPlistError.unexpectedType(marker, offset)
}

func parseStringArrayMinimal(_ data: Data) -> [String]? {
    guard data.count > 8 else { return nil }
    guard let (value, _) = try? parseObjectAtMinimal(data, offset: 8),
          case .array(let items) = value else { return nil }
    return items.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
}

func parseStringArray(_ data: Data) -> [String]? {
    guard data.count >= 8,
          String(bytes: data[0..<8], encoding: .ascii) == "bplist00" else { return nil }
    if data.count >= 40, let result = parseStringArrayStandard(data) { return result }
    return parseStringArrayMinimal(data)
}

// MARK: - bplist building (port of bplist.ts buildStringArray)

func writeUIntN(_ buf: inout [UInt8], offset: Int, val: Int, size: Int) {
    var v = val
    for i in stride(from: size - 1, through: 0, by: -1) {
        buf[offset + i] = UInt8(v & 0xFF)
        v >>= 8
    }
}

func buildIntObject(_ val: Int) -> [UInt8] {
    if val < 0x100   { return [0x10, UInt8(val)] }
    if val < 0x10000 { return [0x11, UInt8(val >> 8), UInt8(val & 0xFF)] }
    return [0x12, UInt8(val >> 24), UInt8((val >> 16) & 0xFF), UInt8((val >> 8) & 0xFF), UInt8(val & 0xFF)]
}

func buildStringObject(_ s: String) -> [UInt8] {
    let strBytes = [UInt8](s.utf8)
    let len = strBytes.count
    var result: [UInt8] = len < 15 ? [0x50 | UInt8(len)] : ([0x5F] + buildIntObject(len))
    result.append(contentsOf: strBytes)
    return result
}

func buildStringArray(_ strings: [String]) -> Data {
    let n = strings.count
    let refSize = n < 255 ? 1 : 2

    var parts: [[UInt8]] = []
    var objectOffsets: [Int] = []
    var pos = 8  // after "bplist00"

    // Object 0: Array
    objectOffsets.append(pos)
    var refs = [UInt8](repeating: 0, count: n * refSize)
    for i in 0..<n { writeUIntN(&refs, offset: i * refSize, val: i + 1, size: refSize) }
    let arrayHeader: [UInt8] = n < 15 ? [0xA0 | UInt8(n)] : ([0xAF] + buildIntObject(n))
    let arrayBuf = arrayHeader + refs
    parts.append(arrayBuf)
    pos += arrayBuf.count

    // Objects 1..n: Strings
    for s in strings {
        objectOffsets.append(pos)
        let strBuf = buildStringObject(s)
        parts.append(strBuf)
        pos += strBuf.count
    }

    // Offset table
    let offsetTablePos = pos
    let numObjects = n + 1
    let offsetIntSize = pos < 256 ? 1 : (pos < 65536 ? 2 : 4)
    var offsetTable = [UInt8](repeating: 0, count: numObjects * offsetIntSize)
    for i in 0..<numObjects {
        writeUIntN(&offsetTable, offset: i * offsetIntSize, val: objectOffsets[i], size: offsetIntSize)
    }

    // Trailer (32 bytes)
    var trailer = [UInt8](repeating: 0, count: 32)
    trailer[6] = UInt8(offsetIntSize)
    trailer[7] = UInt8(refSize)
    var nm = UInt64(numObjects)
    for i in stride(from: 15, through: 8, by: -1) { trailer[i] = UInt8(nm & 0xFF); nm >>= 8 }
    var oto = UInt64(offsetTablePos)
    for i in stride(from: 31, through: 24, by: -1) { trailer[i] = UInt8(oto & 0xFF); oto >>= 8 }

    var result = [UInt8]("bplist00".utf8)
    for part in parts { result.append(contentsOf: part) }
    result.append(contentsOf: offsetTable)
    result.append(contentsOf: trailer)
    return Data(result)
}

// MARK: - Color tag helpers

func isColorTag(_ tag: String) -> Bool {
    guard let nlIdx = tag.lastIndex(of: "\n") else { return false }
    let after = tag[tag.index(after: nlIdx)...]
    guard let idx = Int(after) else { return false }
    return idx >= 1 && idx <= 7
}

func colorIndexFromTags(_ tags: [String]) -> Int? {
    for tag in tags {
        guard let nlIdx = tag.lastIndex(of: "\n") else { continue }
        let after = tag[tag.index(after: nlIdx)...]
        guard let idx = Int(after), idx >= 1, idx <= 7 else { continue }
        return idx
    }
    return nil
}

// MARK: - Operations

func opRead(paths: [String]) -> [[String: Any]] {
    return paths.map { path in
        var entry: [String: Any] = ["path": path]
        if let data = xattrRead(path: path),
           let tags = parseStringArray(data),
           let idx  = colorIndexFromTags(tags) {
            entry["colorIndex"] = idx
        } else {
            entry["colorIndex"] = NSNull()
        }
        return entry
    }
}

func opWrite(path: String, colorIndex: Int) throws {
    guard let colorTagStr = COLOR_TAG_STRINGS[colorIndex] else {
        throw NSError(domain: "HelperError", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "invalid colorIndex \(colorIndex)"])
    }
    var nonColorTags: [String] = []
    if let data = xattrRead(path: path), let tags = parseStringArray(data) {
        nonColorTags = tags.filter { !isColorTag($0) }
    }
    let newTags = nonColorTags + [colorTagStr]
    let plistData = buildStringArray(newTags)
    guard xattrWrite(path: path, data: plistData) else {
        throw NSError(domain: "HelperError", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "setxattr failed for \(path)"])
    }
}

func opClear(path: String) throws {
    var nonColorTags: [String] = []
    if let data = xattrRead(path: path), let tags = parseStringArray(data) {
        nonColorTags = tags.filter { !isColorTag($0) }
    }
    if nonColorTags.isEmpty {
        xattrDelete(path: path)
    } else {
        guard xattrWrite(path: path, data: buildStringArray(nonColorTags)) else {
            throw NSError(domain: "HelperError", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "setxattr failed for \(path)"])
        }
    }
}

// MARK: - JSON I/O

func sendResponse(_ response: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: response),
       let str  = String(data: data, encoding: .utf8) {
        print(str)
        fflush(Darwin.stdout)
    }
}

// MARK: - Main loop

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let reqData = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: reqData) as? [String: Any],
          let id = request["id"] as? Int,
          let op = request["op"] as? String else { continue }

    switch op {
    case "read":
        guard let paths = request["paths"] as? [String] else {
            sendResponse(["id": id, "error": "missing paths"])
            break
        }
        sendResponse(["id": id, "results": opRead(paths: paths)])

    case "write":
        guard let path = request["path"] as? String,
              let colorIndex = request["colorIndex"] as? Int else {
            sendResponse(["id": id, "error": "missing path or colorIndex"])
            break
        }
        do {
            try opWrite(path: path, colorIndex: colorIndex)
            sendResponse(["id": id, "ok": true])
        } catch {
            sendResponse(["id": id, "error": error.localizedDescription])
        }

    case "clear":
        guard let path = request["path"] as? String else {
            sendResponse(["id": id, "error": "missing path"])
            break
        }
        do {
            try opClear(path: path)
            sendResponse(["id": id, "ok": true])
        } catch {
            sendResponse(["id": id, "error": error.localizedDescription])
        }

    default:
        sendResponse(["id": id, "error": "unknown op: \(op)"])
    }
}
