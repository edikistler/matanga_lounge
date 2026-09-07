// character.js — marioneta del personaje: carga las 4 poses cortadas
// (frontal, perfil, perfil-caminando, espalda) y las compone + anima.
//
// Decisiones de arquitectura (confirmadas con Edi):
// - Movimiento lateral (perfil): se anima alternando dos poses completas
//   ya armadas — "de pie" y "caminando" — en vez de rotar huesos. Rotar
//   una pieza pequeña de la pierna lejana no alcanza porque su silueta
//   visible cambia de forma según la zancada (291px -> 526px, +81%), no
//   solo de ángulo. Es un swap duro (sin crossfade): mezclar con alpha
//   dos artes pintadas en poses distintas se ve como doble exposición,
//   no como un paso intermedio limpio.
// - Movimiento hacia/desde cámara (frontal y espalda): NO se rota la
//   pierna (no tiene sentido anatómico ver una pierna rotar hacia la
//   cámara en 2D). Se usa un bob simple: sube-baja + pulso de escala.

const ASSETS_CHAR = "assets/character/";

// Orden de dibujo (de atrás hacia adelante) por vista. Para perfil y
// perfil-caminando, la pierna lejana/trasera va primero (detrás del
// torso) y la cercana/delantera después (delante del torso) — así se ve
// la marioneta correcta y no una silueta plana. Confirmado por área de
// pixel opaco: la pierna que menos área muestra es la que el torso tapa.
const VIEW_ORDER = {
  frontal: ["pantorrilla_izq", "muslo_izq", "pantorrilla_der", "muslo_der",
            "torso", "brazo_izq", "antebrazo_izq", "brazo_der", "antebrazo_der", "cabeza"],
  perfil: ["pantorrilla_lejana", "muslo_lejano_tira", "torso",
           "pantorrilla_cercana", "muslo_cercano",
           "brazo_lejano_tira", "hombro_brazo_cercano", "antebrazo_mano_cercano", "cabeza"],
  "perfil-caminando": ["pantorrilla_a", "muslo_a", "torso", "pantorrilla_b", "muslo_b",
                        "brazo_tira", "antebrazo_mano", "cabeza"],
  espalda: ["pierna_a", "pierna_shoe_a", "torso", "pierna_b", "pierna_shoe_b",
            "antebrazo_mano_a", "manga_fragmento", "antebrazo_mano_b", "brazo_tira", "cabeza"],
};

// Duración de un ciclo de paso completo (contacto -> zancada -> contacto).
const STEP_MS = 520;
const BOB_AMOUNT = 0.035;   // fracción de la altura del personaje
const BOB_SCALE_PULSE = 0.02;

class CharacterRig {
  constructor() {
    this.pieces = {};   // "view/piece" -> HTMLImageElement
    this.canvas = { w: 1150, h: 1336 };
    this.phase = 0;     // 0..1, ciclo de paso actual
    this.walking = false;
  }

  async load() {
    const pivots = await fetch(ASSETS_CHAR + "pivots.json").then(r => r.json());
    this.canvas = pivots.canvas;

    const jobs = [];
    for (const view of Object.keys(VIEW_ORDER)) {
      for (const piece of VIEW_ORDER[view]) {
        const key = view + "/" + piece;
        jobs.push(
          loadImage(`${ASSETS_CHAR}${view}/${piece}.png`).then((img) => {
            this.pieces[key] = img;
          })
        );
      }
    }
    await Promise.all(jobs);
    return this;
  }

  // Avanza el reloj de animación. moving=true hace correr el ciclo de
  // paso; moving=false lo deja congelado en pose "de pie" (phase 0).
  update(dtSeconds, moving) {
    this.walking = moving;
    if (moving) {
      this.phase = (this.phase + dtSeconds * 1000 / STEP_MS) % 1;
    } else {
      this.phase = 0;
    }
  }

  // angleDeg: 0 = mirando a la derecha, 90 = hacia la cámara (frontal),
  // 180/-180 = mirando a la izquierda, -90 = de espaldas (alejándose).
  pickView(angleDeg) {
    const a = ((angleDeg % 360) + 360) % 360; // normaliza a [0,360)
    if (a >= 315 || a < 45) return { view: "perfil", mirror: true };
    if (a >= 45 && a < 135) return { view: "frontal", mirror: false };
    if (a >= 135 && a < 225) return { view: "perfil", mirror: false };
    return { view: "espalda", mirror: false };

  }

  // ctx: sin transform propio (coords = px de canvas destino).
  // x,y: posición de los PIES en px de canvas destino.
  // heightPx: alto deseado del personaje en px de canvas destino.
  render(ctx, x, y, heightPx, angleDeg) {
    const { view, mirror } = this.pickView(angleDeg);
    const isLateral = view === "perfil";
    const activeView = isLateral && this.walking && this.phase >= 0.5
      ? "perfil-caminando"
      : view;

    const scale = heightPx / this.canvas.h;

    ctx.save();
    ctx.translate(x, y);

    // bob solo para frontal/espalda caminando (no tiene pieza propia de
    // "caminando"; es la misma pose de pie con un sube-baja + pulso).
    let bobY = 0;
    let bobScale = 1;
    if (!isLateral && this.walking) {
      const t = Math.sin(this.phase * Math.PI * 2);
      bobY = -Math.abs(t) * heightPx * BOB_AMOUNT;
      bobScale = 1 + Math.abs(t) * BOB_SCALE_PULSE;
    }
    ctx.translate(0, bobY);
    ctx.scale(scale * bobScale * (mirror ? -1 : 1), scale * bobScale);

    // ancla: centro-abajo del lienzo de 1150x1336 de cada pieza cae en
    // los pies del personaje (todas las piezas comparten ese lienzo).
    ctx.translate(-this.canvas.w / 2, -this.canvas.h);

    for (const piece of VIEW_ORDER[activeView]) {
      const img = this.pieces[activeView + "/" + piece];
      if (img) ctx.drawImage(img, 0, 0);
    }

    ctx.restore();
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar: " + src));
    img.src = src;
  });
}
