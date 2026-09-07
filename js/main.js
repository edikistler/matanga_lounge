// main.js — arranque del POC: carga la sala + la marioneta real del
// personaje, calcula la ruta más corta al hacer click (rodeando muebles,
// ver room.findPath), la sigue waypoint a waypoint y renderiza cada frame.

const DISPLAY_SCALE = 1 / 4; // resolución interna del canvas vs. el plate real

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const debugEl = document.getElementById("debug");

const room = new Room();
const rig = new CharacterRig();

const character = {
  x: 3000,
  y: 2450,
  targetX: 3000,
  targetY: 2450,
  path: [], // waypoints pendientes después de targetX/Y (ver room.findPath)
  goalX: 3000, // destino final del último click (para re-calcular ruta si se topa)
  goalY: 2450,
  replans: 0, // re-cálculos hechos para este click (tope, evita bucles)
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
  character.goalX = target.x;
  character.goalY = target.y;
  character.replans = 0;
  followPath(room.findPath(character.x, character.y, target.x, target.y));
}

// Carga una ruta (lista de waypoints, ver room.findPath) como el camino a
// seguir: el primero es el target inmediato, el resto queda en cola.
function followPath(path) {
  if (path.length === 0) {
    character.path = [];
    character.targetX = character.x;
    character.targetY = character.y;
    return;
  }
  character.path = path.slice(1);
  character.targetX = path[0].x;
  character.targetY = path[0].y;
}

// Avanza hasta "distance" px hacia el target actual en sub-pasos chicos,
// verificando que cada sub-paso caiga en zona caminable. Devuelve false si
// se topó con algo antes de completar la distancia.
const SUBSTEP = 8; // mismo paso que room.isSegmentClear
function advanceTowardTarget(distance) {
  let remaining = distance;
  while (remaining > 0) {
    const dx = character.targetX - character.x;
    const dy = character.targetY - character.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return true;
    const s = Math.min(SUBSTEP, remaining, dist);
    const nextX = character.x + (dx / dist) * s;
    const nextY = character.y + (dy / dist) * s;
    if (!room.isWalkable(nextX, nextY)) return false;
    character.x = nextX;
    character.y = nextY;
    remaining -= s;
  }
  return true;
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
    if (!advanceTowardTarget(step)) {
      // Se topó con algo que la ruta no había visto (una rendija entre
      // zonas, un borde). Antes se quedaba parado ahí = "atorado". Ahora
      // re-calcula la ruta al destino desde donde está (con tope de
      // intentos para no ciclar) y sólo si tampoco hay ruta se detiene.
      if (character.replans < 3) {
        character.replans++;
        followPath(room.findPath(character.x, character.y, character.goalX, character.goalY));
      } else {
        followPath([]);
        character.moving = false;
      }
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
