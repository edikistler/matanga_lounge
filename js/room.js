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

  // Caminable = (dentro del polígono del piso O sobre una plataforma) Y
  // fuera de cualquier obstáculo (mueble suelto). Las plataformas pueden
  // quedar fuera del polígono del piso: así el booth se recorta del piso
  // con una muesca y la única forma de subir es por donde el polígono de
  // la plataforma se traslapa con el piso (abajo de las escaleras).
  isWalkable(x, y) {
    const onFloor = pointInPolygon(x, y, this.floor.polygon) || this.platformAt(x, y) !== null;
    return onFloor && !this.isInsideObstacle(x, y);
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

  // Si (x,y) es caminable lo devuelve tal cual. Si no (click sobre un
  // mueble, la barra, la pared...), busca el punto caminable más cercano
  // en cualquier dirección — anillos de 16 direcciones a radios crecientes.
  // Es a propósito una búsqueda y no "el borde más cercano del rectángulo":
  // ese borde puede caer a su vez fuera del piso (p. ej. el sillón verde
  // llega hasta abajo de la imagen) o exactamente sobre la línea, donde la
  // prueba de caminable es ambigua — y el personaje acababa "atorado".
  clampToWalkable(x, y) {
    if (this.isWalkable(x, y)) return { x, y };
    for (let r = 12; r <= 2400; r += r < 200 ? 12 : 40) {
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (this.isWalkable(px, py)) {
          // un poco más adentro en la misma dirección, para que el destino
          // no quede a 2px de un borde (los tramos que salen de ahí lo rozan)
          const qx = x + Math.cos(a) * (r + 40), qy = y + Math.sin(a) * (r + 40);
          return this.isWalkable(qx, qy) ? { x: qx, y: qy } : { x: px, y: py };
        }
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
    const step = 8; // mismo paso que usa main.js al mover, así ruta y movimiento coinciden
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  // Grafo de visibilidad: nodos "para doblar la esquina", separados
  // "margin" px del borde (así el personaje no roza el mueble al pasar
  // pegado). Tres fuentes:
  //  - esquinas de cada obstáculo (4 por rectángulo, hacia afuera)
  //  - vértices del polígono del piso (para rodear la muesca del booth y
  //    cualquier entrante del piso — sin esto sólo sabía rodear rectángulos)
  //  - vértices de las plataformas (para entrar/salir por las escaleras)
  // Para los vértices se prueban 8 direcciones y se conservan las que
  // caen en zona caminable. Salen algunos nodos de más, pero Dijkstra con
  // ~60 nodos es trivial y se calcula sólo al hacer click.
  visibilityNodes() {
    const obstacles = (this.floor.obstacles && this.floor.obstacles.list) || [];
    const platforms = (this.floor.platforms && this.floor.platforms.list) || [];
    const margin = 70;
    const nodes = [];
    const add = (x, y) => { if (this.isWalkable(x, y)) nodes.push({ x, y }); };

    for (const o of obstacles) {
      add(o.x1 - margin, o.y1 - margin);
      add(o.x2 + margin, o.y1 - margin);
      add(o.x1 - margin, o.y2 + margin);
      add(o.x2 + margin, o.y2 + margin);
    }

    const vertexSets = [this.floor.polygon, ...platforms.map((p) => p.polygon)];
    for (const poly of vertexSets) {
      for (const v of poly) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          add(v.x + Math.cos(a) * margin, v.y + Math.sin(a) * margin);
        }
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

    let goal = END;
    if (!isFinite(dist[END])) {
      // Destino inalcanzable (zona encerrada por muebles): en vez de irse
      // en línea recta y toparse, camina hasta el nodo alcanzable más
      // cercano al destino — es lo que hace un point & click clásico.
      let bestD = Infinity;
      goal = -1;
      for (let i = 2; i < n; i++) {
        if (!isFinite(dist[i])) continue;
        const d = Math.hypot(nodes[i].x - endX, nodes[i].y - endY);
        if (d < bestD) { bestD = d; goal = i; }
      }
      if (goal === -1) return []; // ni un nodo alcanzable: no se mueve
    }

    const path = [];
    for (let cur = goal; cur !== -1; cur = prev[cur]) path.unshift(nodes[cur]);
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
