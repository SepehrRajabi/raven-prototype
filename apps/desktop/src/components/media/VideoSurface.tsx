import { useEffect, useRef, useState } from "react";
import {
  acquireVideoContext,
  ExactReader,
  parseFrameHeader,
  RAW_HEADER_BYTES,
  rawStreamUrl,
  releaseVideoContext,
} from "@/lib/videoFrames";

type VideoSurfaceProps = {
  /** The stream's `.mjpg` URL; the raw `.i420` URL is derived from it. */
  src: string;
  className?: string;
  /** Called when the first frame of a (re)connected stream is on screen. */
  onFirstFrame?: () => void;
  /** Called when the picture's pixel size changes. */
  onFrameSize?: (width: number, height: number) => void;
  /** Called when the stream fails or ends. */
  onStreamError?: () => void;
};

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// BT.601 limited range, matching what the JPEG path produced.
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
out vec4 color;
uniform sampler2D ty;
uniform sampler2D tu;
uniform sampler2D tv;
void main() {
  float y = (texture(ty, uv).r - 0.0625) * 1.1643836;
  float u = texture(tu, uv).r - 0.5;
  float v = texture(tv, uv).r - 0.5;
  color = vec4(y + 1.5960268 * v, y - 0.3917623 * u - 0.8129676 * v, y + 2.0172321 * u, 1.0);
}`;

const RETRY_MS = 1000;

type Renderer = {
  draw(width: number, height: number, planes: Uint8Array): void;
  dispose(): void;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const textures = ["ty", "tu", "tv"].map((name, unit) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    return texture;
  });

  let allocated = "";
  return {
    draw(width, height, planes) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      const cw = width / 2;
      const ch = height / 2;
      const key = `${width}x${height}`;
      const ySize = width * height;
      const cSize = cw * ch;
      const slices: [number, number, number, number][] = [
        [0, width, height, ySize],
        [ySize, cw, ch, cSize],
        [ySize + cSize, cw, ch, cSize],
      ];
      slices.forEach(([start, w, h, size], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
        const view = planes.subarray(start, start + size);
        if (allocated === key) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, view);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, view);
      });
      allocated = key;
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      textures.forEach((texture) => gl.deleteTexture(texture));
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/**
 * Draws one native video stream. Raw I420 frames go to a WebGL2 canvas; when WebGL2 is not
 * available (or the page is out of contexts, or a context is lost) it shows the MJPEG stream
 * in an `<img>` instead.
 */
export function VideoSurface({ src, className, onFirstFrame, onFrameSize, onStreamError }: VideoSurfaceProps) {
  const [mode, setMode] = useState<"raw" | "mjpeg">("raw");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onFirstFrame, onFrameSize, onStreamError });
  callbacks.current = { onFirstFrame, onFrameSize, onStreamError };

  useEffect(() => {
    if (mode !== "raw") return;
    const canvas = canvasRef.current;
    if (!canvas || !acquireVideoContext()) {
      setMode("mjpeg");
      return;
    }
    const renderer = createRenderer(canvas);
    if (!renderer) {
      releaseVideoContext();
      setMode("mjpeg");
      return;
    }
    let active = true;
    let abort: AbortController | null = null;
    let retry: number | undefined;
    const onLost = (event: Event) => {
      event.preventDefault();
      setMode("mjpeg");
    };
    canvas.addEventListener("webglcontextlost", onLost);

    const run = async () => {
      let size = "";
      let buffer = new Uint8Array(0);
      const head = new Uint8Array(RAW_HEADER_BYTES);
      abort = new AbortController();
      try {
        const response = await fetch(rawStreamUrl(src), { signal: abort.signal, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error("video stream refused");
        const reader = new ExactReader(response.body.getReader());
        let first = true;
        while (active) {
          await reader.readInto(head);
          const frame = parseFrameHeader(head);
          if (!frame) throw new Error("bad video frame");
          if (buffer.length !== frame.payload) buffer = new Uint8Array(frame.payload);
          await reader.readInto(buffer);
          // Not reading while the window is hidden (no animation frames) lets TCP push back,
          // so the native side drops frames instead of queueing them.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (!active) return;
          renderer.draw(frame.width, frame.height, buffer);
          const next = `${frame.width}x${frame.height}`;
          if (next !== size) {
            size = next;
            callbacks.current.onFrameSize?.(frame.width, frame.height);
          }
          if (first) {
            first = false;
            callbacks.current.onFirstFrame?.();
          }
        }
      } catch {
        if (!active) return;
        callbacks.current.onStreamError?.();
        retry = window.setTimeout(() => void run(), RETRY_MS);
      }
    };
    void run();

    return () => {
      active = false;
      window.clearTimeout(retry);
      abort?.abort();
      canvas.removeEventListener("webglcontextlost", onLost);
      renderer.dispose();
      releaseVideoContext();
    };
  }, [src, mode]);

  if (mode === "mjpeg") {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth && image.naturalHeight) callbacks.current.onFrameSize?.(image.naturalWidth, image.naturalHeight);
          callbacks.current.onFirstFrame?.();
        }}
        onError={() => callbacks.current.onStreamError?.()}
        className={className}
      />
    );
  }
  return <canvas ref={canvasRef} className={className} />;
}
