const ASSETS_ROOM = "assets/room/";

class Room {
  constructor() {
    this.layers = null;
    this.floor = null;
    this.plateImg = null;
    this.layerImgs = {};
    this.scale = 1;
  }

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

  scaleForFeetY(worldY) {
    const r = this.floor.scaleRamp;
    const t = clamp((worldY - r.yFar) / (r.yNear - r.yFar), 0, 1);
    return r.heightAtFar + t * (r.heightAtNear - r.heightAtFar);
  }

  isWalkable(x, y) {
    return pointInPolygon(x, y, this.floor.polygon) && !this.isInsideObstacle(x, y);
  }

  isInsideObstacle(x, y) {
    const obstacles = (this.floor.obstacles && this.floor.obstacles.list) || [];
    return obstacles.some((o) => x >= o.x1 && x <= o.x2 && y >= o.y1 && y <= o.y2);
  }

  platformAt(x, y) {
    const platforms = (this.floor.platforms && this.floor.platforms.list) || [];
    return platforms.find((p) => pointInPolygon(x, y, p.polygon)) || null;
  }

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
