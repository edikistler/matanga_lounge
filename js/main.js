// main.js — arranque del POC: carga la sala + la marioneta real del
// personaje, calcula la ruta más corta al hacer click (rodeando muebles,
// ver room.findPath) y renderiza todo cada frame.

const DISPLAY_SCALE = 1 / 4; // resolución interna del canvas vs. el plate real

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const debugEl = document.getElementById("debug");

const room = new Room();
const rig = new CharacterRig();

const character = {
  x: 2500,
  y: 1600,
  targetX: 2500,
  targetY: 1600,
  path: [], // waypoints pendientes después de targetX/Y (ver room.findPath)
  speed: 900, // px de mundo por segundo
  angleDeg: 90, // hacia la cámara por defecto (ver CharacterRig.pickView)
  moving: false,
};

let lastTs = 0;

async function init() {
  await Promise.all([room.load(DISPLAY_SCALE), rig.load()]);

  canvas.width = Math.round(room.plateSize.w * DISPLAY_SCALE);
  canvas.height = Math.round(room.plateSize.h * DISPLAY_SCALE);

  canvas.addEventListener("click", onClick);
  requestAnimationFrame(loop);
}

function onClick(ev) {
  const rect = canvas.getBoundingClientRect();
  // click en CSS px -> px internos del canvas -> coords de mundo (plate)
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const canvasX = (ev.clientX - rect.left) * scaleX;
  const canvasY = (ev.clientY - rect.top) * scaleY;
  const worldX = canvasX / DISPLAY_SCALE;
  const worldY = canvasY / DISPLAY_SCALE;

  // si el click cae fuera del área caminable, lo llevamos al punto del
  // borde del polígono (o del mueble) más cercano en vez de ignorarlo —
  // se siente más parecido a un point & click real que quedarse quieto.
  const target = room.clampToWalkable(worldX, worldY);

  // room.findPath calcula la ruta más corta rodeando muebles (grafo de
  // visibilidad + Dijkstra) — si no hay nada en medio, es simplemente el
  // punto final en línea recta, igual que antes.
  const path = room.findPath(character.x, character.y, target.x, target.y);
  if (path.length === 0) return;
  character.path = path.slice(1);
  character.targetX = path[0].x;
  character.targetY = path[0].y;
}

function updateCharacter(dtSeconds) {
  const dx = character.targetX - character.x;
  const dy = character.targetY - character.y;
  const dist = Math.hypot(dx, dy);
  const step = character.speed * dtSeconds;

  if (dist > 1) {
    // ángulo de pantalla: 0=derecha, 90=abajo/hacia cámara, -90=arriba/espalda
    character.angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  if (dist > step) {
    character.moving = true;
    const nextX = character.x + (dx / dist) * step;
    const nextY = character.y + (dy / dist) * step;
    if (room.isWalkable(nextX, nextY)) {
      character.x = nextX;
      character.y = nextY;
    } else {
      // no debería pasar ya con la ruta calculada, pero por seguridad no
      // atraviesa el obstáculo si de algún modo el tramo quedó obstruido.
      character.path = [];
      character.targetX = character.x;
      character.targetY = character.y;
      character.moving = false;
    }
  } else {
    character.x = character.targetX;
    character.y = character.targetY;
    if (character.path.length > 0) {
      // llegó a este waypoint intermedio: sigue con el siguiente tramo de
      // la ruta sin que el jugador tenga que volver a hacer click.
      const next = character.path.shift();
      character.targetX = next.x;
      character.targetY = next.y;
      character.moving = true;
    } else {
      character.moving = false;
    }
  }

  rig.update(dtSeconds, character.moving);
}

function drawCharacter() {
  const s = DISPLAY_SCALE;
  const heightPx = room.scaleForFeetY(character.y) * s;
  const platform = room.platformAt(character.x, character.y);
  const liftPx = platform ? platform.lift * s : 0;
  rig.render(ctx, character.x * s, character.y * s - liftPx, heightPx, character.angleDeg);
}

function loop(ts) {
  const dtSeconds = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;

  updateCharacter(dtSeconds);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  room.render(ctx, character.x, character.y, drawCharacter);

  const { front, behind } = room.groupLayers(character.x, character.y);
  debugEl.textContent =
    `pies: ${character.x.toFixed(0)}, ${character.y.toFixed(0)}  ángulo: ${character.angleDeg.toFixed(0)}°  ${character.moving ? "caminando" : "quieto"}\n` +
    `altura: ${room.scaleForFeetY(character.y).toFixed(0)}px  vista: ${rig.pickView(character.angleDeg).view}\n` +
    `delante del personaje: ${front.length}\n` +
    `detrás del personaje: ${behind.map((l) => l.file).join(", ") || "(ninguna)"}`;

  requestAnimationFrame(loop);
}

// expuestos para depuración / pruebas automatizadas (Playwright, consola)
window.character = character;
window.rig = rig;
window.room = room;

init().catch((err) => {
  debugEl.textContent = "ERROR: " + err.message;
  console.error(err);
});
