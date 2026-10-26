// Lift the main subject out of a photo with Vision and composite it on a flat colour.
// Usage: swift cutout.swift <in> <out.png> <hexbg>
import Foundation
import Vision
import CoreImage
import AppKit
let a = CommandLine.arguments
let url = URL(fileURLWithPath: a[1])
guard let ci = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { print("load fail"); exit(1) }
let handler = VNImageRequestHandler(ciImage: ci)
let req = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([req])
guard let obs = req.results?.first else { print("no subject"); exit(1) }
let maskBuf = try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler)
let mask = CIImage(cvPixelBuffer: maskBuf)
let hex = UInt32(a[3], radix: 16)!
let bg = CIImage(color: CIColor(red: CGFloat((hex>>16)&0xff)/255, green: CGFloat((hex>>8)&0xff)/255, blue: CGFloat(hex&0xff)/255)).cropped(to: ci.extent)
let out = ci.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: bg, kCIInputMaskImageKey: mask])
let ctx = CIContext()
try ctx.writePNGRepresentation(of: out, to: URL(fileURLWithPath: a[2]), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
print("ok", Int(ci.extent.width), Int(ci.extent.height))
