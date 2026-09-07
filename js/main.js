const DISPLAY_SCALE = 1 / 4;

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
  speed: 900,
  angleDeg: 90,
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
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const canvasX = (ev.clientX - rect.left) * scaleX;
  const canvasY = (ev.clientY - rect.top) * scaleY;
  const worldX = canvasX / DISPLAY_SCALE;
  const worldY = canvasY / DISPLAY_SCALE;

  const target = room.clampToWalkable(worldX, worldY);
  character.targetX = target.x;
  character.targetY = target.y;
}

function updateCharacter(dtSeconds) {
  const dx = character.targetX - character.x;
  const dy = character.targetY - character.y;
  const dist = Math.hypot(dx, dy);
  const step = character.speed * dtSeconds;

  character.moving = dist > 1;

  if (character.moving) {
    character.angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  if (dist > step) {
    const nextX = character.x + (dx / dist) * step;
    const nextY = character.y + (dy / dist) * step;
    if (room.isWalkable(nextX, nextY)) {
      character.x = nextX;
      character.y = nextY;
    } else {
      character.targetX = character.x;
      character.targetY = character.y;
      character.moving = false;
    }
  } else if (room.isWalkable(character.targetX, character.targetY)) {
    character.x = character.targetX;
    character.y = character.targetY;
  }

  rig.update(dtSeconds, character.moving);
}

function drawCharacter() {
  const s = DISPLAY_SCALE;
  const heightPx = room.scaleForFeetY(character.y) * s;
  rig.render(ctx, character.x * s, character.y * s, heightPx, character.angleDeg);
}

function loop(ts) {
  const dtSeconds = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;

  updateCharacter(dtSeconds);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  room.render(ctx, character.y, drawCharacter);

  const { front, behind } = room.groupLayers(character.y);
  debugEl.textContent =
    `pies: ${character.x.toFixed(0)}, ${character.y.toFixed(0)}  ángulo: ${character.angleDeg.toFixed(0)}°  ${character.moving ? "caminando" : "quieto"}\n` +
    `altura: ${room.scaleForFeetY(character.y).toFixed(0)}px  vista: ${rig.pickView(character.angleDeg).view}\n` +
    `delante del personaje: ${front.length}\n` +
    `detrás del personaje: ${behind.map((l) => l.file).join(", ") || "(ninguna)"}`;

  requestAnimationFrame(loop);
}

window.character = character;
window.rig = rig;
window.room = room;

init().catch((err) => {
  debugEl.textContent = "ERROR: " + err.message;
  console.error(err);
});
