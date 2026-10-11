// ocr_image.swift —— 用 macOS Vision 框架对截图做 OCR，输出带坐标的文本行
//
// 用途：SKILL.md §8「条件允许时与 OCR 交叉验证」的落地实现。
//       判读频谱仪截图时，先把 marker 表 OCR 出来，再用人工判读规则复核，
//       两者不一致的地方就是高风险点。
//
// 用法:
//   swift ocr_image.swift <图片...> [--json] [--lang=en-US] [--region=x,y,w,h]
//   swift ocr_image.swift 图.jpg                  # 逐行打印 [x0,y0,x1,y1] 文本
//   swift ocr_image.swift 图.jpg --json           # 机器可读（含置信度）
//   swift ocr_image.swift 图.jpg --region=0,0.6,1,0.4   # 只看下半部分（marker 表区）
//   swift ocr_image.swift 图.jpg --region=0,0.6,0.45,0.32 --scale=3   # 裁表区 + 放大 3×
//
//   swift ocr_image.swift 图.jpg --region=0,0.6,0.45,0.32 --scale=6 --save=/tmp/crop.png
//
// 精度提示：仪器读数属小字，**强烈建议先 --region 裁到读数区再 --scale=3 放大**，
//          放大后 OCR 准确率显著高于整图直接识别。
//          存疑的数字用 --save 导出放大图、人工核对，是最可靠的一步。
//
// 坐标约定：输出为「左上原点」的归一化坐标（0~1），x0,y0=左上角，x1,y1=右下角。
//   Vision 原生为左下原点，本工具已转换，便于直接按「从上到下、从左到右」排序。
//
// 说明：不依赖任何第三方库，不上网，纯本地推理。

import Foundation
import Vision
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Line {
    let text: String
    let x0: Double, y0: Double, x1: Double, y1: Double
    let conf: Double
}

func loadCGImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func esc(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) }
            else { out.unicodeScalars.append(ch) }
        }
    }
    return out
}

// ---- 参数 ----
var paths: [String] = []
var asJSON = false
var langs = ["en-US"]
var region: (Double, Double, Double, Double)? = nil
var scale = 1.0
var savePath: String? = nil

for a in CommandLine.arguments.dropFirst() {
    if a == "--json" { asJSON = true }
    else if a.hasPrefix("--lang=") { langs = a.replacingOccurrences(of: "--lang=", with: "").split(separator: ",").map(String.init) }
    else if a.hasPrefix("--region=") {
        let n = a.replacingOccurrences(of: "--region=", with: "").split(separator: ",").map { Double($0) ?? 0 }
        if n.count == 4 { region = (n[0], n[1], n[2], n[3]) }
    }
    else if a.hasPrefix("--scale=") { scale = max(1.0, min(8.0, Double(a.replacingOccurrences(of: "--scale=", with: "")) ?? 1.0)) }
    else if a.hasPrefix("--save=") { savePath = a.replacingOccurrences(of: "--save=", with: "") }
    else { paths.append(a) }
}

// 按 scale 重绘（放大/缩小），放大后再 OCR 对小字读数更稳
func rescale(_ img: CGImage, _ s: Double) -> CGImage? {
    if abs(s - 1.0) < 1e-6 { return img }
    let w = Int((Double(img.width) * s).rounded())
    let h = Int((Double(img.height) * s).rounded())
    guard w > 0, h > 0,
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

if paths.isEmpty {
    FileHandle.standardError.write("用法: swift ocr_image.swift <图片...> [--json] [--lang=en-US,zh-Hans] [--region=x,y,w,h]\n".data(using: .utf8)!)
    exit(2)
}

var jsonItems: [String] = []
var failed = 0

for p in paths {
    guard let cg = loadCGImage(p) else {
        failed += 1
        if asJSON { jsonItems.append("{\"file\":\"\(esc(p))\",\"error\":\"无法读取\"}") }
        else { print("■ \(p)\n  ✗ 无法读取") }
        continue
    }

    var crop = cg
    if let r = region {
        let W = Double(cg.width), H = Double(cg.height)
        let rect = CGRect(x: r.0 * W, y: r.1 * H, width: r.2 * W, height: r.3 * H)
        if let c = cg.cropping(to: rect) { crop = c }
    }
    if let up = rescale(crop, scale) { crop = up }

    if let sp = savePath {
        let url = URL(fileURLWithPath: sp)
        if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, crop, nil)
            CGImageDestinationFinalize(dest)
            FileHandle.standardError.write("  ↳ 已导出裁剪放大图: \(sp)  (\(crop.width)×\(crop.height))\n".data(using: .utf8)!)
        }
    }

    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = langs
    req.usesLanguageCorrection = false      // 仪器读数不要语言纠错
    req.minimumTextHeight = 0.0

    let handler = VNImageRequestHandler(cgImage: crop, options: [:])
    do { try handler.perform([req]) } catch {
        failed += 1
        if asJSON { jsonItems.append("{\"file\":\"\(esc(p))\",\"error\":\"OCR 失败\"}") }
        else { print("■ \(p)\n  ✗ OCR 失败: \(error)") }
        continue
    }

    var lines: [Line] = []
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox                       // 左下原点
        let x0 = Double(b.minX)
        let y0 = Double(1.0 - b.maxY)                 // → 左上原点
        let x1 = Double(b.maxX)
        let y1 = Double(1.0 - b.minY)
        lines.append(Line(text: top.string, x0: x0, y0: y0, x1: x1, y1: y1, conf: Double(top.confidence)))
    }
    // 从上到下、从左到右
    lines.sort { a, b in
        if abs(a.y0 - b.y0) > 0.012 { return a.y0 < b.y0 }
        return a.x0 < b.x0
    }

    if asJSON {
        let arr = lines.map { l in
            String(format: "{\"text\":\"%@\",\"x0\":%.5f,\"y0\":%.5f,\"x1\":%.5f,\"y1\":%.5f,\"conf\":%.3f}",
                   esc(l.text), l.x0, l.y0, l.x1, l.y1, l.conf)
        }.joined(separator: ",")
        jsonItems.append("{\"file\":\"\(esc(p))\",\"w\":\(crop.width),\"h\":\(crop.height),\"lines\":[\(arr)]}")
    } else {
        print("■ \(p)   \(crop.width)×\(crop.height)   \(lines.count) 行")
        for l in lines {
            print(String(format: "  [%.3f,%.3f,%.3f,%.3f] %@", l.x0, l.y0, l.x1, l.y1, l.text))
        }
    }
}

if asJSON {
    print("{\"results\":[\(jsonItems.joined(separator: ","))]}")
}
exit(failed == paths.count ? 1 : 0)
