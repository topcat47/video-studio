// Free on-device AI upscale with Apple's VideoToolbox super-resolution (macOS 26+, 4x only).
// Decodes <in.mp4>, upscales every frame 4x (temporal: each frame uses the previous one, reset at
// the listed cut frames), scales the result down to <W>x<H> with high-quality resampling and writes
// raw BGRA frames to stdout for ffmpeg:
//   sr4x <in.mp4> <W> <H> [cuts.txt] | ffmpeg -f rawvideo -pix_fmt bgra -s WxH -r <source fps> -i - ...
// cuts.txt: one 0-based frame number per line where a new shot starts. Progress goes to stderr.
// Apple's video model takes at most 1920x1080, so portrait input (taller than 1080, e.g. 720x1280)
// is turned on its side for the upscale and turned back (W x H stay the portrait output size).
// The first run downloads Apple's model (one time, from Apple).
// Build: swiftc -O -parse-as-library sr4x.swift -o sr4x
import AVFoundation
import Accelerate
import CoreMedia
import VideoToolbox

func fail(_ s: String) -> Never {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    exit(1)
}

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func makePool(_ attrs: [String: Any]) -> CVPixelBufferPool {
    var pool: CVPixelBufferPool?
    guard CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool) == kCVReturnSuccess, let p = pool
    else { fail("pool create failed: \(attrs)") }
    return p
}

func buffer(_ pool: CVPixelBufferPool) -> CVPixelBuffer {
    var b: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &b) == kCVReturnSuccess, let buf = b
    else { fail("pool buffer failed") }
    return buf
}

func bgra(_ w: Int, _ h: Int) -> CVPixelBuffer {
    var b: CVPixelBuffer?
    let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()]
    guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &b) == kCVReturnSuccess,
          let buf = b else { fail("bgra buffer failed") }
    return buf
}

@main
struct SR4x {
    static func main() async throws {
        let a = CommandLine.arguments
        guard a.count >= 4, let outW = Int(a[2]), let outH = Int(a[3]) else {
            fail("usage: sr4x <in.mp4> <W> <H> [cuts.txt]")
        }
        var cuts = Set<Int>()
        if a.count >= 5, let text = try? String(contentsOfFile: a[4], encoding: .utf8) {
            for line in text.split(separator: "\n") { if let n = Int(line.trimmingCharacters(in: .whitespaces)) { cuts.insert(n) } }
        }

        let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no video track") }
        let size = try await track.load(.naturalSize)
        let inW = Int(size.width), inH = Int(size.height)
        let portrait = inH > 1080
        if portrait && inW > 1080 { fail("\(inW)x\(inH) is larger than 1920x1080 either way round") }
        let wW = portrait ? inH : inW, wH = portrait ? inW : inH          // what the model sees
        let oW = portrait ? outH : outW, oH = portrait ? outW : outH      // downscale target before turning back

        guard VTSuperResolutionScalerConfiguration.isSupported else { fail("super resolution not supported on this Mac") }
        guard let config = VTSuperResolutionScalerConfiguration(
            frameWidth: wW, frameHeight: wH, scaleFactor: 4, inputType: .video, usePrecomputedFlow: false,
            qualityPrioritization: .normal, revision: VTSuperResolutionScalerConfiguration.defaultRevision)
        else { fail("no 4x configuration for \(wW)x\(wH)") }

        if config.configurationModelStatus != .ready {
            log("downloading Apple's super-resolution model (one time)...")
            do { try await config.downloadConfigurationModel() } catch { fail("model download failed: \(error)") }
            while config.configurationModelStatus != .ready {
                log(String(format: "  model %.0f%%", config.configurationModelPercentageAvailable * 100))
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            log("model ready")
        }

        let processor = VTFrameProcessor()
        try processor.startSession(configuration: config)
        let srcPool = makePool(config.sourcePixelBufferAttributes)
        let dstPool = makePool(config.destinationPixelBufferAttributes)

        var transfer: VTPixelTransferSession?
        VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer)
        guard let xfer = transfer else { fail("transfer session failed") }

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { fail("reader failed: \(String(describing: reader.error))") }

        let bigW = wW * 4, bigH = wH * 4
        let big = bgra(bigW, bigH)
        let small = bgra(oW, oH)
        let sideways = bgra(wW, wH)       // portrait input turned clockwise
        let upright = bgra(outW, outH)    // portrait output turned back
        var black: [UInt8] = [0, 0, 0, 255]

        func rotate(_ from: CVPixelBuffer, _ to: CVPixelBuffer, _ fw: Int, _ fh: Int, _ tw: Int, _ th: Int, _ how: Int) {
            CVPixelBufferLockBaseAddress(from, .readOnly)
            CVPixelBufferLockBaseAddress(to, [])
            var s = vImage_Buffer(data: CVPixelBufferGetBaseAddress(from), height: vImagePixelCount(fh),
                                  width: vImagePixelCount(fw), rowBytes: CVPixelBufferGetBytesPerRow(from))
            var d = vImage_Buffer(data: CVPixelBufferGetBaseAddress(to), height: vImagePixelCount(th),
                                  width: vImagePixelCount(tw), rowBytes: CVPixelBufferGetBytesPerRow(to))
            let err = vImageRotate90_ARGB8888(&s, &d, UInt8(how), &black, vImage_Flags(kvImageNoFlags))
            CVPixelBufferUnlockBaseAddress(to, [])
            CVPixelBufferUnlockBaseAddress(from, .readOnly)
            if err != kvImageNoError { fail("rotate failed \(err)") }
        }
        let stdout = FileHandle.standardOutput
        var prevSrc: VTFrameProcessorFrame?
        var prevDst: VTFrameProcessorFrame?
        var n = 0
        let bypass = ProcessInfo.processInfo.environment["SR_BYPASS"] == "1"
        let t0 = Date()

        while let sample = output.copyNextSampleBuffer() {
            guard let decoded = CMSampleBufferGetImageBuffer(sample) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            var input: CVPixelBuffer = decoded
            if portrait {
                rotate(decoded, sideways, inW, inH, wW, wH, kRotate90DegreesClockwise)
                input = sideways
            }
            let srcBuf = buffer(srcPool)
            guard VTPixelTransferSessionTransferImage(xfer, from: input, to: srcBuf) == noErr else { fail("to source format failed") }
            let dstBuf = buffer(dstPool)
            guard let src = VTFrameProcessorFrame(buffer: srcBuf, presentationTimeStamp: pts),
                  let dst = VTFrameProcessorFrame(buffer: dstBuf, presentationTimeStamp: pts) else { fail("frame wrap failed") }
            let fresh = cuts.contains(n) || prevSrc == nil
            guard let params = VTSuperResolutionScalerParameters(
                sourceFrame: src, previousFrame: fresh ? nil : prevSrc, previousOutputFrame: fresh ? nil : prevDst,
                opticalFlow: nil, submissionMode: .sequential, destinationFrame: dst) else { fail("params failed") }
            if bypass {
                // colour-path check: plain 4x resize of the decoded frame instead of super resolution
                guard VTPixelTransferSessionTransferImage(xfer, from: input, to: big) == noErr else { fail("bypass failed") }
            } else {
                try await processor.process(parameters: params)
                // 4x result -> BGRA -> high-quality downscale to the target size
                guard VTPixelTransferSessionTransferImage(xfer, from: dstBuf, to: big) == noErr else { fail("from dest failed") }
            }
            CVPixelBufferLockBaseAddress(big, .readOnly)
            CVPixelBufferLockBaseAddress(small, [])
            var s = vImage_Buffer(data: CVPixelBufferGetBaseAddress(big), height: vImagePixelCount(bigH),
                                  width: vImagePixelCount(bigW), rowBytes: CVPixelBufferGetBytesPerRow(big))
            var d = vImage_Buffer(data: CVPixelBufferGetBaseAddress(small), height: vImagePixelCount(oH),
                                  width: vImagePixelCount(oW), rowBytes: CVPixelBufferGetBytesPerRow(small))
            let err = vImageScale_ARGB8888(&s, &d, nil, vImage_Flags(kvImageHighQualityResampling))
            if err != kvImageNoError { fail("scale failed \(err)") }
            CVPixelBufferUnlockBaseAddress(small, [])
            CVPixelBufferUnlockBaseAddress(big, .readOnly)

            var out = small
            if portrait {
                rotate(small, upright, oW, oH, outW, outH, kRotate90DegreesCounterClockwise)
                out = upright
            }
            CVPixelBufferLockBaseAddress(out, .readOnly)
            let rowBytes = CVPixelBufferGetBytesPerRow(out)
            let base = CVPixelBufferGetBaseAddress(out)!
            if rowBytes == outW * 4 {
                stdout.write(Data(bytes: base, count: outW * 4 * outH))
            } else {
                var frame = Data(capacity: outW * 4 * outH)
                for y in 0..<outH { frame.append(Data(bytes: base + y * rowBytes, count: outW * 4)) }
                stdout.write(frame)
            }
            CVPixelBufferUnlockBaseAddress(out, .readOnly)

            prevSrc = src
            prevDst = dst
            n += 1
            if n % 100 == 0 { log(String(format: "%d frames, %.1f fps", n, Double(n) / Date().timeIntervalSince(t0))) }
        }
        processor.endSession()
        if reader.status == .failed { fail("read failed: \(String(describing: reader.error))") }
        log("done: \(n) frames in \(Int(Date().timeIntervalSince(t0))) s")
    }
}
