/**
 * MediaPipe Face Landmarker (Apache-2.0), run locally in the browser — photos never leave the
 * machine. Measures reference photos only: 478 face landmarks, 52 expression blendshapes and a
 * head pose matrix. The WASM files come from the npm package (bundled by Vite), the model from
 * public/portrait/mediapipe/face_landmarker.task.
 */
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

export const MODEL_URL = '/portrait/mediapipe/face_landmarker.task';

let landmarker: Promise<FaceLandmarker> | null = null;

export function faceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarker) {
    landmarker = FaceLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      },
    );
    landmarker.catch(() => (landmarker = null));
  }
  return landmarker;
}

export interface FaceDetection {
  width: number;
  height: number;
  /** 478 landmarks: x, y in pixels (origin top-left), z relative depth in the same pixel scale (smaller = nearer). */
  points: Float32Array;
  /** Expression blendshapes (ARKit-style names, 0…1). */
  blendshapes: Record<string, number>;
  /** Head pose: 4×4 transform of MediaPipe's canonical face (column-major), if available. */
  matrix: number[] | null;
}

export type ImageInput = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

export async function detectFace(image: ImageInput): Promise<FaceDetection | null> {
  const fl = await faceLandmarker();
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const r = fl.detect(image as HTMLCanvasElement);
  const lm = r.faceLandmarks[0];
  if (!lm) return null;
  const points = new Float32Array(lm.length * 3);
  lm.forEach((p, i) => {
    points[i * 3] = p.x * width;
    points[i * 3 + 1] = p.y * height;
    points[i * 3 + 2] = p.z * width;
  });
  const blendshapes: Record<string, number> = {};
  for (const c of r.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
  const m = r.facialTransformationMatrixes[0];
  return { width, height, points, blendshapes, matrix: m ? Array.from(m.data) : null };
}
