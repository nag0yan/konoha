import { createServer } from "node:http";

createServer((req, res) => {
  if (req.url === "/health") {
    res.end("vm-ok");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>Drawing test</title>
<canvas width="400" height="240" style="border:1px solid;touch-action:none"></canvas>
<script>
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
canvas.onpointerdown = (event) => {
  canvas.setPointerCapture(event.pointerId);
  context.beginPath();
  context.moveTo(event.offsetX, event.offsetY);
};
canvas.onpointermove = (event) => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  context.lineTo(event.offsetX, event.offsetY);
  context.stroke();
};
</script>`);
}).listen(Number(process.env.PORT), process.env.HOST);
