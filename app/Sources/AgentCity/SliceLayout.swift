import CoreGraphics

struct Slice: Equatable {
    let x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat
}

struct SliceLayout: Equatable {
    let fullW: CGFloat, fullH: CGFloat
    let slices: [Slice]

    /// `frames` are AppKit global screen frames (origin bottom-left, y up).
    /// Slices use a top-left origin, matching `camera.setViewOffset`.
    static func make(frames: [CGRect]) -> SliceLayout {
        guard let first = frames.first else { return SliceLayout(fullW: 0, fullH: 0, slices: []) }
        let union = frames.dropFirst().reduce(first) { $0.union($1) }
        let slices = frames.map { f in
            Slice(x: f.minX - union.minX, y: union.maxY - f.maxY, w: f.width, h: f.height)
        }
        return SliceLayout(fullW: union.width, fullH: union.height, slices: slices)
    }

    /// The left-most display shows the overlay and runs at full frame rate.
    var showcaseIndex: Int {
        slices.indices.min { slices[$0].x < slices[$1].x } ?? 0
    }

    static func selfTest() -> Bool {
        var ok = true
        func check(_ c: Bool, _ msg: String) { if !c { print("FAIL: \(msg)"); ok = false } }
        // Main display in the middle (origin 0,0), one left, one right.
        let three = make(frames: [
            CGRect(x: 0, y: 0, width: 1920, height: 1080),
            CGRect(x: -1920, y: 0, width: 1920, height: 1080),
            CGRect(x: 1920, y: 0, width: 1920, height: 1080),
        ])
        check(three.fullW == 5760 && three.fullH == 1080, "three wide union")
        check(three.slices[0] == Slice(x: 1920, y: 0, w: 1920, h: 1080), "main slice in middle")
        check(three.slices[1].x == 0 && three.slices[2].x == 3840, "left/right slices")
        check(three.showcaseIndex == 1, "showcase is left-most")
        // Mixed heights, bottoms aligned: shorter display sits lower in the top-left frame.
        let mixed = make(frames: [CGRect(x: 0, y: 0, width: 2560, height: 1440), CGRect(x: 2560, y: 0, width: 1920, height: 1080)])
        check(mixed.fullH == 1440 && mixed.slices[1].y == 360, "mixed heights")
        check(make(frames: []).slices.isEmpty, "no screens")
        print(ok ? "self-test ok" : "self-test failed")
        return ok
    }
}
