import type { BrowLandmark } from '../core/mh/brows.ts';

/**
 * MediaPipe face mesh landmark groups (indices into the 478 landmarks), taken from
 * @mediapipe/tasks-vision 1.2.0 (FaceLandmarker.FACE_LANDMARKS_*; Apache-2.0). "left" / "right"
 * follow MediaPipe (the subject's own side). Generated once so pure code does not load the WASM bundle.
 */
export const FACE_OVAL = [10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150, 152, 162, 172, 176, 234, 251, 284, 288, 297, 323, 332, 338, 356, 361, 365, 377, 378, 379, 389, 397, 400, 454];
export const LIPS = [0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91, 95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311, 312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415];
export const LEFT_EYE = [249, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390, 398, 466];
export const RIGHT_EYE = [7, 33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163, 173, 246];
export const LEFT_BROW = [276, 282, 283, 285, 293, 295, 296, 300, 334, 336];
export const RIGHT_BROW = [46, 52, 53, 55, 63, 65, 66, 70, 105, 107];
export const LEFT_IRIS = [474, 475, 476, 477];
export const RIGHT_IRIS = [469, 470, 471, 472];

/** Iris centres (subject's left, right). */
export const IRIS_CENTER = { left: 473, right: 468 } as const;

/** The face oval as a closed polygon (MediaPipe FACE_LANDMARKS_FACE_OVAL connection order), starting at the forehead top. */
export const FACE_OVAL_ORDER = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

/**
 * The lower face outline (subject's left cheek at ear level → chin → right cheek). These lie on
 * the head's silhouette and are fitted as contours; the upper oval follows the hairline, which a
 * bald sculpture does not have, so it is not used.
 */
export const LOWER_OVAL = FACE_OVAL_ORDER.slice(FACE_OVAL_ORDER.indexOf(454), FACE_OVAL_ORDER.indexOf(234) + 1);

/** Calibrated brow landmark models (see BROW_POINTS), inner → outer: [along, alongPerLength, across, acrossPerHalf]. */
const BROW_UPPER: [number, number, number, number][] = [
  [0, -0.093, -1.05, 1],
  [0, 0.185, -0.67, 1],
  [0, 0.47, 1.02, 1],
  [0, 0.765, 0.02, 1],
  [0, 0.968, -2.02, 1],
];
const BROW_LOWER: [number, number, number, number][] = [
  [0, -0.125, -3.3, -1],
  [0, 0.168, 1.67, -1],
  [0, 0.405, 1.84, -1],
  [0, 0.62, -0.23, -1],
  [0, 0.815, -3.71, -1],
];

/**
 * MediaPipe's eyebrow contours, inner → outer end: subject's side, upper (+1) or lower (−1) edge
 * and where MediaPipe puts the point on a sculpted brow (core/mh/brows.ts BrowLandmark: along the
 * brow, offset from its edge). Calibrated with window.portrait.calibrateBrows on 33 photo-like
 * renders (brows darkened like hair; 11 faces × yaw −20/0/20°), left and right averaged: the inner
 * points sit a little inside the brow's inner end, the lower inner and outer points 3–4 mm below
 * the lower edge. Compared with the sculpted brow, not with fixed vertices.
 */
export const BROW_POINTS: { k: number; side: 'left' | 'right'; edge: 1 | -1; m: BrowLandmark }[] = (
  [
    ['left', 1, [336, 296, 334, 293, 300]],
    ['left', -1, [285, 295, 282, 283, 276]],
    ['right', 1, [107, 66, 105, 63, 70]],
    ['right', -1, [55, 65, 52, 53, 46]],
  ] as const
).flatMap(([side, edge, ks]) =>
  ks.map((k, i) => {
    const [along, alongPerLength, across, acrossPerHalf] = (edge > 0 ? BROW_UPPER : BROW_LOWER)[i]!;
    return { k, side, edge, m: { along, alongPerLength, across, acrossPerHalf } };
  }),
);
