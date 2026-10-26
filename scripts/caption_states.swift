// Render karaoke-style caption overlays (transparent PNGs) for a 1080x1920 video.
// Usage: swift caption_states.swift <states.txt> <outdir> [fontSize] [line1CenterY] [lineGap]
// states.txt: one state per line, "<id>\t<line one>|<line two>". Words starting with "~" are
// drawn grey (not yet spoken), the rest white; each gets a soft dark shadow.
// Matches a common Instagram/CapCut caption style.
import Foundation
import AppKit

let a = CommandLine.arguments
guard a.count >= 3, let text = try? String(contentsOfFile: a[1], encoding: .utf8) else {
    print("usage: <states.txt> <outdir> [fontSize] [line1CenterY] [lineGap]"); exit(1)
}
let outDir = a[2]
let size = a.count > 3 ? CGFloat(Double(a[3])!) : 50
let y1 = a.count > 4 ? CGFloat(Double(a[4])!) : 1407
let gap = a.count > 5 ? CGFloat(Double(a[5])!) : 58
let W = 1080, H = 1920
let font = NSFont.systemFont(ofSize: size, weight: .bold)
let white = NSColor.white, grey = NSColor(white: 0.82, alpha: 0.55)
let shadow = NSShadow()
shadow.shadowColor = NSColor(white: 0, alpha: 0.75); shadow.shadowBlurRadius = 6; shadow.shadowOffset = NSSize(width: 0, height: -2)

for row in text.split(separator: "\n") {
    let parts = row.split(separator: "\t", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { continue }
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    var lines: [NSAttributedString] = []
    for line in parts[1].split(separator: "|") {
        let s = NSMutableAttributedString()
        for (wi, w) in line.split(separator: " ").enumerated() {
            let isGrey = w.hasPrefix("~")
            let word = isGrey ? String(w.dropFirst()) : String(w)
            if wi > 0 { s.append(NSAttributedString(string: " ", attributes: [.font: font])) }
            s.append(NSAttributedString(string: word, attributes: [.font: font, .foregroundColor: isGrey ? grey : white, .shadow: shadow]))
        }
        lines.append(s)
    }
    // the block is centred on its widest line; lines are left-aligned inside it (as in the source)
    let blockW = lines.map { $0.size().width }.max() ?? 0
    for (li, s) in lines.enumerated() {
        let cy = y1 + CGFloat(li) * gap                       // centre, measured from the top
        s.draw(at: NSPoint(x: (CGFloat(W) - blockW) / 2, y: CGFloat(H) - cy - s.size().height / 2))
    }
    NSGraphicsContext.current = nil
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/\(parts[0]).png"))
}
