// Render TikTok-style text (white, heavy, black outline + soft shadow) onto a transparent full-frame PNG,
// for overlaying with ffmpeg (this Mac's ffmpeg has no drawtext).
// Usage: swift text_png.swift <out.png> <frameW> <frameH> <centerY> <fontSize> "<line 1>" ["<line 2>" ...]
import AppKit

let a = CommandLine.arguments
guard a.count >= 7, let W = Int(a[2]), let H = Int(a[3]), let cy = Double(a[4]), let size = Double(a[5]) else {
    print("usage: <out.png> <W> <H> <centerY> <fontSize> <line> [line ...]"); exit(1)
}
let lines = Array(a[6...])
let font = NSFont.systemFont(ofSize: size, weight: .heavy)
let para = NSMutableParagraphStyle()
para.alignment = .center
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.6)
shadow.shadowBlurRadius = size * 0.18
shadow.shadowOffset = NSSize(width: 0, height: -size * 0.04)
let fill: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white, .paragraphStyle: para, .shadow: shadow]
let stroke: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.clear, .paragraphStyle: para,
                                              .strokeColor: NSColor.black, .strokeWidth: 9.0]

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let text = lines.joined(separator: "\n")
let measured = NSAttributedString(string: text, attributes: fill).boundingRect(
    with: NSSize(width: Double(W) * 0.9, height: Double(H)), options: [.usesLineFragmentOrigin])
// AppKit's origin is bottom-left; centerY is measured from the top of the frame
let rect = NSRect(x: Double(W) * 0.05, y: Double(H) - cy - measured.height / 2, width: Double(W) * 0.9, height: measured.height)
NSAttributedString(string: text, attributes: stroke).draw(with: rect, options: [.usesLineFragmentOrigin])
NSAttributedString(string: text, attributes: fill).draw(with: rect, options: [.usesLineFragmentOrigin])
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[1]))
print("ok")
