package main

import (
	"image"
	"math"
)

type rgb struct{ r, g, b byte }

var (
	green = rgb{0x2d, 0xa4, 0x4e}
	amber = rgb{0xe0, 0x9b, 0x18}
	grey  = rgb{0x8a, 0x8a, 0x8a}
)

var icons = map[rgb][]byte{}

// icon is the tray icon in the status colour, in the format this system's tray takes (encodeIcon: .ico on
// Windows, PNG elsewhere).
func icon(c rgb) []byte {
	if b, ok := icons[c]; ok {
		return b
	}
	icons[c] = encodeIcon(drawIcon(c))
	return icons[c]
}

// drawIcon draws a ring and a centre dot (a hub) in the colour, 32x32.
func drawIcon(c rgb) *image.NRGBA {
	const n = 32
	img := image.NewNRGBA(image.Rect(0, 0, n, n))
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			d := math.Hypot(float64(x)+0.5-n/2, float64(y)+0.5-n/2)
			// Coverage of the ring (radius 11.5-15) and the dot (radius 6), anti-aliased over one pixel.
			a := math.Max(clamp(15.5-d)*clamp(d-10.5), clamp(6.5-d))
			copy(img.Pix[img.PixOffset(x, y):], []byte{c.r, c.g, c.b, byte(a * 255)})
		}
	}
	return img
}

func clamp(v float64) float64 { return math.Min(1, math.Max(0, v)) }
