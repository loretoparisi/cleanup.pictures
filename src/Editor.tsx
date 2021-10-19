import { DownloadIcon, EyeIcon } from '@heroicons/react/outline'
import React, { useCallback, useEffect, useState } from 'react'
import { useFirebase } from './adapters/firebase'
import inpaint from './adapters/inpainting'
import Button from './components/Button'
import Slider from './components/Slider'
import { downloadImage, loadImage, useImage } from './utils'

interface EditorProps {
  file: File
}

interface Line {
  size?: number
  pts: { x: number; y: number }[]
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: Line[],
  color = 'rgba(255, 0, 0, 0.5)'
) {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  lines.forEach(line => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach(pt => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}

export default function Editor(props: EditorProps) {
  const { file } = props
  const [brushSize, setBrushSize] = useState(40)
  const [original, isOriginalLoaded] = useImage(file)
  const [render] = useState(new Image())
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [maskCanvas] = useState<HTMLCanvasElement>(() => {
    return document.createElement('canvas')
  })
  const [lines] = useState<Line[]>([{ pts: [] }])
  const [{ x, y }, setCoords] = useState({ x: -1, y: -1 })
  const [showBrush, setShowBrush] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [isInpaintingLoading, setIsInpaintingLoading] = useState(false)
  const firebase = useFirebase()

  const draw = useCallback(() => {
    if (!context) {
      return
    }
    context.clearRect(0, 0, context.canvas.width, context.canvas.height)
    if (render.src) {
      context.drawImage(render, 0, 0)
    } else {
      context.drawImage(original, 0, 0)
    }
    const currentLine = lines[lines.length - 1]
    drawLines(context, [currentLine])
  }, [context, lines, original, render])

  const refreshCanvasMask = useCallback(() => {
    if (!context?.canvas.width || !context?.canvas.height) {
      throw new Error('canvas has invalid size')
    }
    maskCanvas.width = context?.canvas.width
    maskCanvas.height = context?.canvas.height
    const ctx = maskCanvas.getContext('2d')
    if (!ctx) {
      throw new Error('could not retrieve mask canvas')
    }
    drawLines(ctx, lines, 'white')
  }, [context?.canvas.height, context?.canvas.width, lines, maskCanvas])

  // Draw once the original image is loaded
  useEffect(() => {
    if (!context?.canvas) {
      return
    }
    if (isOriginalLoaded) {
      firebase?.logEvent('image_loaded', {
        width: original.width,
        height: original.height,
      })
      context.canvas.width = original.width
      context.canvas.height = original.height
      draw()
    }
  }, [context?.canvas, draw, original, isOriginalLoaded, firebase])

  // Handle mouse interactions
  useEffect(() => {
    if (!firebase) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }
    const onMouseMove = (ev: MouseEvent) => {
      setCoords({ x: ev.pageX, y: ev.pageY })
    }
    const onPaint = (ev: MouseEvent) => {
      const currLine = lines[lines.length - 1]
      currLine.pts.push({
        x: ev.pageX - canvas.offsetLeft,
        y: ev.pageY - canvas.offsetTop,
      })
      draw()
    }
    const onMouseUp = async () => {
      if (!original.src) {
        return
      }
      setIsInpaintingLoading(true)
      canvas.removeEventListener('mousemove', onPaint)
      window.removeEventListener('mouseup', onMouseUp)
      refreshCanvasMask()
      try {
        const start = Date.now()
        firebase?.logEvent('inpaint_start')
        const { token } = await firebase.getAppCheckToken()
        const res = await inpaint(file, maskCanvas.toDataURL(), token)
        if (!res) {
          throw new Error('empty response')
        }
        // TODO: fix the render if it failed loading
        await loadImage(render, res)
        firebase?.logEvent('inpaint_processed', {
          duration: Date.now() - start,
          width: original.width,
          height: original.height,
        })
      } catch (e: any) {
        firebase?.logEvent('inpaint_failed', {
          error: e,
        })
        // eslint-disable-next-line
        alert(e.message ? e.message : e.toString())
      }

      lines.push({ pts: [] } as Line)
      setIsInpaintingLoading(false)
      draw()
    }
    window.addEventListener('mousemove', onMouseMove)
    canvas.onmouseenter = () => setShowBrush(true)
    canvas.onmouseleave = () => setShowBrush(false)
    canvas.onmousedown = e => {
      if (!original.src) {
        return
      }
      const currLine = lines[lines.length - 1]
      currLine.size = brushSize
      canvas.addEventListener('mousemove', onPaint)
      window.addEventListener('mouseup', onMouseUp)
      onPaint(e)
    }

    return () => {
      canvas.removeEventListener('mousemove', onPaint)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.onmouseenter = null
      canvas.onmouseleave = null
      canvas.onmousedown = null
    }
  }, [
    brushSize,
    context,
    file,
    draw,
    lines,
    refreshCanvasMask,
    maskCanvas,
    original.src,
    render,
    firebase,
    original.height,
    original.width,
  ])

  function download() {
    firebase?.logEvent('download')
    const base64 = context?.canvas.toDataURL(file.type)
    if (!base64) {
      throw new Error('could not get canvas data')
    }
    const name = file.name.replace(/(\.[\w\d_-]+)$/i, '_cleanup$1')
    downloadImage(base64, name)
  }

  return (
    <div
      className={[
        'flex flex-col items-center',
        isInpaintingLoading ? 'animate-pulse-fast pointer-events-none' : '',
      ].join(' ')}
    >
      <canvas
        className="rounded-sm"
        style={showBrush ? { cursor: 'none' } : {}}
        ref={r => {
          if (r && !context) {
            const ctx = r.getContext('2d')
            if (ctx) {
              setContext(ctx)
            }
          }
        }}
      />
      {showOriginal ? (
        <img className="absolute" src={original.src} alt="original" />
      ) : (
        <></>
      )}
      {showBrush && (
        <div
          className="absolute rounded-full bg-red-500 bg-opacity-50 pointer-events-none"
          style={{
            width: `${brushSize}px`,
            height: `${brushSize}px`,
            left: `${x}px`,
            top: `${y}px`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
      <div className="flex items-center justify-between space-x-5 w-full max-w-4xl py-6">
        <Slider
          label="Brush Size"
          min={10}
          max={150}
          value={brushSize}
          onChange={setBrushSize}
        />
        <Button
          icon={<EyeIcon className="w-6 h-6" />}
          onDown={() => setShowOriginal(true)}
          onUp={() => setShowOriginal(false)}
        >
          Original
        </Button>
        <Button
          primary
          icon={<DownloadIcon className="w-6 h-6" />}
          onClick={download}
        >
          Download
        </Button>
      </div>
    </div>
  )
}