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

  // Punto dentro del polígono caminable Y fuera de cualquier obstáculo
  // (mueble) — ambas condiciones tienen que cumplirse.
  isWalkable(x, y) {
    return pointInPolygon(x, y, this.floor.polygon) && !this.isInsideObstacle(x, y);
  }

  isInsideObstacle(x, y) {
    const obstacles = (this.floor.obstacles && this.floor.obstacles.list) || [];
    return obstacles.some((o) => x >= o.x1 && x <= o.x2 && y >= o.y1 && y <= o.y2);
  }

  // Devuelve la plataforma (zona elevada) en la que cae (x,y), o null.
  platformAt(x, y) {
    const platforms = (this.floor.platforms && this.floor.platforms.list) || [];
    return platforms.find((p) => pointInPolygon(x, y, p.polygon)) || null;
  }

  // Si (x,y) ya es caminable lo devuelve tal cual. Si cae fuera del
  // polígono, lo manda al borde del polígono más cercano. Si cae dentro
  // de un obstáculo, lo manda al borde de ESE obstáculo más cercano —
  // así un click sobre un mueble mueve al personaje hasta pegado a él,
  // en vez de no hacer nada o meterlo adentro.
  clampToWalkable(x, y) {
    if (!pointInPolygon(x, y, this.floor.polygon)) {
      return closestPointOnPolygon(x, y, this.floor.polygon);
    }
    const obstacles = (this.floor.obstacles && this.floor.obstacles.list) || [];
    for (const o of obstacles) {
      if (x >= o.x1 && x <= o.x2 && y >= o.y1 && y <= o.y2) {
        return closestPointOnRect(x, y, o);
      }
    }
    return { x, y };
  }

  // Un segmento se considera "libre" si TODOS sus puntos muestreados caen
  // en zona caminable (dentro del polígono y fuera de cualquier mueble).
  // step chico (px de mundo) para no "saltarse" muebles angostos si el
  // segmento pasa en diagonal.
  isSegmentClear(ax, ay, bx, by) {
    const dist = Math.hypot(bx - ax, by - ay);
    const step = 15;
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  // Grafo de visibilidad: nodos = esquinas de cada mueble, separadas
  // "margin" px hacia afuera (así el personaje no roza el mueble al pasar
  // pegado a la esquina), descartando las que caigan fuera del piso o
  // dentro de OTRO mueble.
  visibilityNodes() {
    const obstacles = (this.floor.obstacles && this.floor.obstacles.list) || [];
    const margin = 90;
    const nodes = [];
    for (const o of obstacles) {
      const corners = [
        { x: o.x1 - margin, y: o.y1 - margin },
        { x: o.x2 + margin, y: o.y1 - margin },
        { x: o.x1 - margin, y: o.y2 + margin },
        { x: o.x2 + margin, y: o.y2 + margin },
      ];
      for (const c of corners) {
        if (this.isWalkable(c.x, c.y)) nodes.push(c);
      }
    }
    return nodes;
  }

  // Ruta más corta de (startX,startY) a (endX,endY) rodeando muebles —
  // grafo de visibilidad (esquinas de muebles + inicio/fin) + Dijkstra.
  // Devuelve un arreglo de waypoints SIN incluir el punto de partida (el
  // primero ya es hacia dónde moverse). Si no hay muebles de por medio,
  // es simplemente [{x: endX, y: endY}] — línea recta, como antes.
  findPath(startX, startY, endX, endY) {
    if (this.isSegmentClear(startX, startY, endX, endY)) {
      return [{ x: endX, y: endY }];
    }

    const nodes = [{ x: startX, y: startY }, { x: endX, y: endY }, ...this.visibilityNodes()];
    const n = nodes.length;
    const START = 0, END = 1;

    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (this.isSegmentClear(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y)) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          adj[i].push({ to: j, d });
          adj[j].push({ to: i, d });
        }
      }
    }

    // Dijkstra sencillo (n es chico: ~30-40 nodos, no hace falta heap).
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    const visited = new Array(n).fill(false);
    dist[START] = 0;
    for (let iter = 0; iter < n; iter++) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u === -1 || u === END) break;
      visited[u] = true;
      for (const e of adj[u]) {
        const nd = dist[u] + e.d;
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
      }
    }

    if (!isFinite(dist[END])) {
      // no se encontró ruta (no debería pasar con el target ya clampeado a
      // zona caminable) — de todos modos apunta directo, mejor eso que
      // quedarse congelado sin hacer nada.
      return [{ x: endX, y: endY }];
    }

    const path = [];
    for (let cur = END; cur !== -1; cur = prev[cur]) path.unshift(nodes[cur]);
    return path.slice(1); // sin el nodo de partida
  }

  // Dibuja: plate -> capas "delante del personaje" (siempre, según regla)
  // -> callback del personaje -> capas "detrás del personaje".
  // ctx ya debe tener el scale de mundo->pantalla aplicado.
  // feetX,feetY: posición (coords de mundo) de los pies del personaje ahora mismo.
  render(ctx, feetX, feetY, drawCharacter) {
    ctx.drawImage(this.plateImg, 0, 0);

    const { front, behind } = this.groupLayers(feetX, feetY);

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
  // Si el personaje está parado sobre una plataforma (tarima elevada),
  // su forceFrontLayer se fuerza a "front" aunque la regla normal de
  // baselineY diría que debería tapar al personaje — si no, el recorte
  // de la tarima lo escondería en vez de dejarlo verse parado encima.
  groupLayers(feetX, feetY) {
    const platform = this.platformAt(feetX, feetY);
    const front = [];
    const behind = [];
    for (const layer of this.layers.layers) {
      const forcedFront = platform && platform.forceFrontLayer === layer.file;
      if (forcedFront || layer.baselineY === null || feetY >= layer.baselineY) {
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

// Punto más cercano sobre el borde de un rectángulo {x1,y1,x2,y2}, dado
// un (x,y) que cae DENTRO de él. Empuja hacia el lado más cercano.
function closestPointOnRect(x, y, r) {
  const dLeft = x - r.x1, dRight = r.x2 - x, dTop = y - r.y1, dBottom = r.y2 - y;
  const m = Math.min(dLeft, dRight, dTop, dBottom);
  if (m === dLeft) return { x: r.x1, y };
  if (m === dRight) return { x: r.x2, y };
  if (m === dTop) return { x, y: r.y1 };
  return { x, y: r.y2 };
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
