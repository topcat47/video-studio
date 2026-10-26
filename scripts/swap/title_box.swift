// Render a TikTok "white box" title (black text on a white rounded box) onto a transparent full-frame PNG,
// for re-lettering burned-in titles (a name on screen swapped for the character's) and overlaying with ffmpeg (no drawtext here).
// Usage: swift title_box.swift <out.png> <frameW> <frameH> <boxX> <boxY> <boxW> <boxH> <fontSize> "<line 1>" ["<line 2>" ...]
// Lines are centred in the box; emoji render in colour. Measure the box on a full-size source frame first.
import AppKit

let a = CommandLine.arguments
guard a.count >= 10, let W = Double(a[2]), let H = Double(a[3]), let bx = Double(a[4]), let by = Double(a[5]),
      let bw = Double(a[6]), let bh = Double(a[7]), let fs = Double(a[8]) else {
    print("usage: <out.png> <frameW> <frameH> <boxX> <boxY> <boxW> <boxH> <fontSize> \"<line>\" …"); exit(1)
}
let lines = Array(a[9...])
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.clear(CGRect(x: 0, y: 0, width: W, height: H))
// box (AppKit's origin is bottom-left)
let box = CGRect(x: bx, y: H - by - bh, width: bw, height: bh)
ctx.setFillColor(NSColor.white.cgColor)
ctx.addPath(CGPath(roundedRect: box, cornerWidth: 6, cornerHeight: 6, transform: nil)); ctx.fillPath()
let font = NSFont(name: "AvenirNext-Medium", size: CGFloat(fs)) ?? NSFont.systemFont(ofSize: CGFloat(fs), weight: .medium)
let para = NSMutableParagraphStyle(); para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black, .paragraphStyle: para]
let lineH = CGFloat(fs) * 1.24
let total = lineH * CGFloat(lines.count)
var top = CGFloat(by) + (CGFloat(bh) - total) / 2
for line in lines {
    let r = CGRect(x: CGFloat(bx), y: CGFloat(H) - top - lineH, width: CGFloat(bw), height: lineH)
    NSAttributedString(string: line, attributes: attrs).draw(in: r)
    top += lineH
}
NSGraphicsContext.current?.flushGraphics()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[1]))
print("ok", a[1])
