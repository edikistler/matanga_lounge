// room.js — carga el plate + capas de la sala y resuelve el orden de dibujo
// (personaje delante/detrás de cada recorte) según la regla de baselineY.
//
// Regla: cada capa con baselineY definido representa la Y (en coords del
// plate completo) donde ese objeto "toca piso" en la escena. Si los pies
// del personaje (feetY) quedan por ENCIMA de ese valor (feetY < baselineY,
// o sea más al fondo/arriba en la imagen), el personaje va DETRÁS del
// recorte. Si quedan por debajo (feetY >= baselineY, más al frente), el
// personaje va DELANTE. baselineY = null significa objeto montado en alto
// (bocinas colgadas, parche de esquina): el personaje siempre va delante.

const ASSETS_ROOM = "assets/room/";

class Room {
  constructor() {
    this.layers = null;      // layers.json
    this.floor = null;       // floor.json
    this.plateImg = null;    // canvas ya reescalado a resolución de pantalla
    this.layerImgs = {};     // file -> canvas ya reescalado
    this.scale = 1;          // factor mundo(plate real) -> canvas
  }

  // displayScale: resolución interna del canvas / resolución real del plate.
  // Las imágenes (plate de varios MB de píxeles + hasta una docena de capas)
  // se reescalan UNA sola vez aquí en vez de dibujarse a tamaño completo en
  // cada frame vía ctx.scale — sin esto, el requestAnimationFrame se vuelve
  // carísimo (recompone ~17M px por capa, 60 veces por segundo) y en canvas
  // headless/software-rendering eso alcanza a colgar hasta un screenshot.
  async load(displayScale = 1) {
    this.scale = displayScale;

    const [layersRes, floorRes] = await Promise.all([
      fetch(ASSETS_ROOM + "layers.json").then(r => r.json()),
      fetch(ASSETS_ROOM + "floor.json").then(r => r.json()),
    ]);
    this.layers = layersRes;
    this.floor = floorRes;

    const w = Math.round(this.layers.plateSize.w * displayScale);
    const h = Math.round(this.layers.plateSize.h * displayScale);

    const plateFull = await loadImage(ASSETS_ROOM + this.layers.plate);
    this.plateImg = downscale(plateFull, w, h);

    await Promise.all(
      this.layers.layers.map(async (layer) => {
        const full = await loadImage(ASSETS_ROOM + layer.file);
        this.layerImgs[layer.file] = downscale(full, w, h);
      })
    );

    return this;
  }

  get plateSize() {
    return this.layers.plateSize;
  }

  // Altura en pantalla (px, coords de mundo/plate) que debería tener el
  // personaje parado con los pies en worldY, interpolando la rampa de
  // floor.json y sujetando (clamping) a los extremos.
  scaleForFeetY(worldY) {
    const r = this.floor.scaleRamp;
    const t = clamp((worldY - r.yFar) / (r.yNear - r.yFar), 0, 1);
    return r.heightAtFar + t * (r.heightAtNear - r.heightAtFar);
  }

  // Punto dentro del polígono caminable (coords de mundo).
  isWalkable(x, y) {
    return pointInPolygon(x, y, this.floor.polygon);
  }

  // Si (x,y) ya es caminable lo devuelve tal cual; si no, devuelve el
  // punto más cercano sobre el borde del polígono. Así un click fuera del
  // área (por ejemplo un poco más allá de la pared) igual mueve al
  // personaje hasta el borde válido más próximo, en vez de no hacer nada.
  clampToWalkable(x, y) {
    if (this.isWalkable(x, y)) return { x, y };
    return closestPointOnPolygon(x, y, this.floor.polygon);
  }

  // Dibuja: plate -> capas "delante del personaje" (siempre, según regla)
  // -> callback del personaje -> capas "detrás del personaje".
  // ctx ya debe tener el scale de mundo->pantalla aplicado.
  // feetY: posición Y (coords de mundo) de los pies del personaje ahora mismo.
  render(ctx, feetY, drawCharacter) {
    ctx.drawImage(this.plateImg, 0, 0);

    const { front, behind } = this.groupLayers(feetY);

    for (const layer of front) {
      ctx.drawImage(this.layerImgs[layer.file], 0, 0);
    }

    drawCharacter();

    for (const layer of behind) {
      ctx.drawImage(this.layerImgs[layer.file], 0, 0);
    }
  }

  // front: se dibujan ANTES del personaje (el personaje las tapa).
  // behind: se dibujan DESPUÉS del personaje (lo tapan a él).
  groupLayers(feetY) {
    const front = [];
    const behind = [];
    for (const layer of this.layers.layers) {
      if (layer.baselineY === null || feetY >= layer.baselineY) {
        front.push(layer);
      } else {
        behind.push(layer);
      }
    }
    return { front, behind };
  }
}

function downscale(img, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c;
}

function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return { x: ax + abx * t, y: ay + aby * t };
}

function closestPointOnPolygon(x, y, polygon) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p = closestPointOnSegment(x, y, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar: " + src));
    img.src = src;
  });
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Ray casting estándar, polygon = [{x,y}, ...]
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
