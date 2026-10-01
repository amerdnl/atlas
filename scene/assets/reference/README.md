# Reference wallpaper art

`atlas-reference.png` is the approved ATLAS reference artwork (1672×941, lossless PNG) with the HUD
that was baked into the original image removed — the live HUD is drawn by the page.

Regenerate it from the original with:

    node tools/prepare-reference.mjs <original-reference.png>

## How the scene uses it (`scene/src/reference-scene.js`)

The art shows every district lit in its role color. The scene derives both states from this one
image, in a fragment shader, with no extra image assets:

- **Idle:** inside each district's mask, pixels whose hue matches that role's light are turned
  into neutral light of the same perceived brightness (warm white for lights, cool grey for
  facades). Everything else is the art, untouched.
- **Active:** the district's original pixels are restored through its mask (the reference's own
  lit district, including its colored reflections), with the ~3 s working breathe; blocked turns
  that light a restrained warning red.

District masks are authored as data — soft ellipses per district, in reference pixels — in
`scene/src/reference-map.js` (with the label/path anchors and each role's hue window) and turned
into a small RGBA mask texture at load. Tests in `scene/test/reference.test.js` check them against
light sampled from this image.
