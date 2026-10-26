// Labelled contact sheet for planning and review (this Mac's ffmpeg has no drawtext).
// Usage: [SB_TH=<thumb height, default 150>] swift scripts/swap/storyboard.swift <spec.txt> <out.png>
// spec lines (tab-separated):  title<TAB>text   |   row<TAB>label<TAB>sublabel<TAB>img[@caption]|img[@caption]|...
import Foundation
import AppKit
import CoreText

let a = CommandLine.arguments
guard a.count == 3, let spec = try? String(contentsOfFile: a[1], encoding: .utf8) else { print("usage: <spec> <out.png>"); exit(1) }
struct Row { var label: String; var sub: String; var imgs: [(CGImage, String)] }
var title = ""; var rows: [Row] = []
for line in spec.split(separator: "\n") {
    let f = line.components(separatedBy: "\t")
    if f[0] == "title" { title = f[1] }
    if f[0] == "row" {
        var imgs: [(CGImage, String)] = []
        for item in f[3].components(separatedBy: "|") where !item.isEmpty {
            let parts = item.components(separatedBy: "@")
            guard let im = NSImage(contentsOfFile: parts[0])?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("missing", parts[0]); exit(1) }
            imgs.append((im, parts.count > 1 ? parts[1] : ""))
        }
        rows.append(Row(label: f[1], sub: f[2], imgs: imgs))
    }
}
let TH = CGFloat(Double(ProcessInfo.processInfo.environment["SB_TH"] ?? "150") ?? 150), GAP: CGFloat = 6, PAD: CGFloat = 24, PER = 8
func tw(_ im: CGImage) -> CGFloat { TH * CGFloat(im.width) / CGFloat(im.height) }
let rowW = rows.map { r in stride(from: 0, to: r.imgs.count, by: PER).map { s in r.imgs[s..<min(s + PER, r.imgs.count)].reduce(0) { $0 + tw($1.0) + GAP } }.max() ?? 0 }.max() ?? 800
let W = max(rowW + 2 * PAD, 1200)
func lines(_ r: Row) -> Int { (r.imgs.count + PER - 1) / PER }
let labelH: CGFloat = 64, titleH: CGFloat = title.isEmpty ? 0 : 70
let H = titleH + PAD + rows.reduce(0) { $0 + labelH + CGFloat(lines($1)) * (TH + GAP) + 18 } + PAD
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.setFillColor(NSColor(calibratedWhite: 0.08, alpha: 1).cgColor); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
func text(_ s: String, _ x: CGFloat, _ yTop: CGFloat, _ size: CGFloat, _ color: NSColor, bold: Bool = false, shadow: Bool = false) {
    let font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color]))
    let y = H - yTop - size
    if shadow {
        let sh = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: NSColor.black]))
        for (dx, dy) in [(-1.5, 0.0), (1.5, 0.0), (0.0, -1.5), (0.0, 1.5)] { ctx.textPosition = CGPoint(x: x + dx, y: y + dy); CTLineDraw(sh, ctx) }
    }
    ctx.textPosition = CGPoint(x: x, y: y); CTLineDraw(line, ctx)
}
var y = PAD
if !title.isEmpty { text(title, PAD, y, 34, .white, bold: true); y += titleH }
for r in rows {
    text(r.label, PAD, y, 25, .white, bold: true)
    text(r.sub, PAD, y + 33, 19, NSColor(calibratedRed: 1, green: 0.78, blue: 0.35, alpha: 1))
    y += labelH
    for s in stride(from: 0, to: r.imgs.count, by: PER) {
        var x = PAD
        for (im, cap) in r.imgs[s..<min(s + PER, r.imgs.count)] {
            let w = tw(im)
            ctx.draw(im, in: CGRect(x: x, y: H - y - TH, width: w, height: TH))
            if !cap.isEmpty { text(cap, x + 6, y + TH - 26, 18, .white, bold: true, shadow: true) }
            x += w + GAP
        }
        y += TH + GAP
    }
    y += 18
}
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
print("ok", Int(W), Int(H))
