import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";

const GLASS_SURFACES =
  ".sidebar,.modal,.market-filters,.inspector,.canvas-header,.canvas-toolbar,.model-card,.glass-panel,.table-wrap,.project-card,.auth-form,.section-band,.news-item,.asset-card,.stats,.wallet-plan-card,.plan-card,.mobile-bar,.toast,.announcement-popover";
// Floating chrome gets its own lens: content passing underneath bends at the rim.
const LENS_SURFACES =
  ".sidebar,.canvas-header,.canvas-toolbar,.inspector,.modal,.toast,.mobile-bar,.announcement-popover,.react-flow__controls,.market-filters,.auth-form";
// Cards lean toward the pointer like a pane of glass held in the hand.
const TILT_SURFACES =
  ".project-card,.model-card.directory-card,.asset-card,.wallet-plan-card,.plan-card";
// Controls that carry their own specular highlight at the pointer.
const GLASS_CONTROLS =
  "button,.button,.sidebar nav > a,.sidebar-bottom > a,.search,.search-field,.market-search";
// Controls that stretch like a drop when pressed and dragged.
const JELLY_CONTROLS = "button:not(:disabled),.button,.sidebar nav > a";
// Containers whose `.active` child sits on a single sliding glass thumb.
const THUMB_HOSTS =
  ".sidebar nav,.tabs,.segmented-tabs,.wallet-tabs,.admin-settings-tabs";
const SVG = "http://www.w3.org/2000/svg";

type Box = { x: number; y: number; w: number; h: number };

function edgeDisplacement(width: number, height: number, radius: number) {
  const ratio = Math.min(1, 256 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.round(width * ratio));
  canvas.height = Math.max(8, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(canvas.width, canvas.height);
  const bevel = Math.min(22, Math.min(width, height) / 4);
  const corner = Math.min(radius, width / 2, height / 2);
  // A rounded-rectangle distance field bends only the rim; the center stays optically flat.
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = ((x + 0.5) / canvas.width - 0.5) * width;
      const py = ((y + 0.5) / canvas.height - 0.5) * height;
      const qx = Math.abs(px) - width / 2 + corner;
      const qy = Math.abs(py) - height / 2 + corner;
      const ox = Math.max(qx, 0),
        oy = Math.max(qy, 0);
      const length = Math.hypot(ox, oy);
      const depth = corner - length - Math.min(Math.max(qx, qy), 0);
      const bend =
        depth > 0 && depth < bevel ? Math.sin((Math.PI * depth) / bevel) : 0;
      const nx = (length ? ox / length : qx > qy ? 1 : 0) * Math.sign(px);
      const ny = (length ? oy / length : qx > qy ? 0 : 1) * Math.sign(py);
      const offset = (y * canvas.width + x) * 4;
      image.data[offset] = 128 + nx * bend * 110;
      image.data[offset + 1] = 128 + ny * bend * 110;
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

const boxCss = (b: Box) => ({
  left: `${b.x}px`,
  top: `${b.y}px`,
  width: `${b.w}px`,
  height: `${b.h}px`,
});

// Halfway through a move the leading edge has nearly arrived while the trailing
// edge lags behind, so the thumb stretches like a drop and thins across the move.
function stretched(from: Box, to: Box): Box {
  const axis = (a0: number, a1: number, b0: number, b1: number) => {
    const forward = b0 + b1 > a0 + a1;
    const start = a0 + (b0 - a0) * (forward ? 0.3 : 0.88);
    const end = a1 + (b1 - a1) * (forward ? 0.88 : 0.3);
    return [start, end] as const;
  };
  const [x0, x1] = axis(from.x, from.x + from.w, to.x, to.x + to.w);
  const [y0, y1] = axis(from.y, from.y + from.h, to.y, to.y + to.h);
  const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
  const squeezeX = vertical ? (x1 - x0) * 0.05 : 0;
  const squeezeY = vertical ? 0 : (y1 - y0) * 0.08;
  return {
    x: x0 + squeezeX,
    y: y0 + squeezeY,
    w: x1 - x0 - squeezeX * 2,
    h: y1 - y0 - squeezeY * 2,
  };
}

// Rubber-band pull: follows the finger at first, then resists harder the further it goes.
const pull = (distance: number, reach: number) =>
  Math.sign(distance) * reach * (1 - 1 / (1 + Math.abs(distance) / reach));

export function LiquidGlassAtmosphere() {
  const displacement = useRef<SVGFEImageElement>(null);
  const ripples = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const firstRoute = useRef(true);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    const prepared = new Map<HTMLElement, string>();
    const maps = new Map<string, string>();
    let active: HTMLElement | null = null;
    let activeNav: HTMLElement | null = null;
    let pending: PointerEvent | null = null;
    let frame = 0;
    let x = 50,
      y = 50,
      targetX = 50,
      targetY = 50,
      angle = 160,
      targetAngle = 160;

    const mapFor = (width: number, height: number, radius: number) => {
      const key = `${Math.round(width)}:${Math.round(height)}:${radius}`;
      let map = maps.get(key);
      if (!map) {
        map = edgeDisplacement(width, height, radius);
        if (maps.size >= 24) maps.delete(maps.keys().next().value!);
        maps.set(key, map);
      }
      return map;
    };

    const updateRefraction = () => {
      if (!active || active.hasAttribute("data-lens")) return;
      const rect = active.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const radius =
        parseFloat(getComputedStyle(active).borderTopLeftRadius) || 0;
      displacement.current?.setAttribute(
        "href",
        mapFor(rect.width, rect.height, radius),
      );
    };
    const resize = new ResizeObserver(updateRefraction);

    const prepare = (surface: HTMLElement) => {
      // Hidden chrome (the phone bar on desktop) is prepared once it renders,
      // so its media-query position is never pinned by an inline style.
      if (prepared.has(surface) || !surface.getClientRects().length) return;
      prepared.set(surface, surface.style.position);
      if (getComputedStyle(surface).position === "static")
        surface.style.position = "relative";
      surface.classList.add("glass-ready");
    };

    // Each lens surface owns a filter sized to it, so several can refract at once.
    const lensDefs = document.createElementNS(SVG, "svg");
    lensDefs.setAttribute("class", "liquid-filter-defs");
    lensDefs.setAttribute("aria-hidden", "true");
    document.body.appendChild(lensDefs);
    const lensSupported = CSS.supports(
      "backdrop-filter",
      'url("#liquid-edge-refraction") blur(1px)',
    );
    const lenses = new Map<
      HTMLElement,
      { filter: SVGFilterElement; image: SVGFEImageElement }
    >();
    let lensCount = 0;
    const shapeLens = (surface: HTMLElement) => {
      const lens = lenses.get(surface);
      if (!lens || !surface.offsetWidth || !surface.offsetHeight) return;
      const radius =
        parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;
      lens.image.setAttribute(
        "href",
        mapFor(surface.offsetWidth, surface.offsetHeight, radius),
      );
    };
    const lensResize = new ResizeObserver((entries) =>
      entries.forEach((entry) => shapeLens(entry.target as HTMLElement)),
    );
    const attachLens = (surface: HTMLElement) => {
      if (lenses.has(surface)) return;
      const id = `liquid-lens-${++lensCount}`;
      const filter = document.createElementNS(SVG, "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", "1");
      filter.setAttribute("height", "1");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const image = document.createElementNS(SVG, "feImage");
      image.setAttribute("x", "0");
      image.setAttribute("y", "0");
      image.setAttribute("width", "100%");
      image.setAttribute("height", "100%");
      image.setAttribute("preserveAspectRatio", "none");
      image.setAttribute("result", "edgeMap");
      const bend = document.createElementNS(SVG, "feDisplacementMap");
      bend.setAttribute("in", "SourceGraphic");
      bend.setAttribute("in2", "edgeMap");
      bend.setAttribute("scale", "26");
      bend.setAttribute("xChannelSelector", "R");
      bend.setAttribute("yChannelSelector", "G");
      filter.append(image, bend);
      lensDefs.appendChild(filter);
      lenses.set(surface, { filter, image });
      surface.style.setProperty("--lens", `url(#${id})`);
      surface.setAttribute("data-lens", "");
      shapeLens(surface);
      lensResize.observe(surface);
    };

    const clear = () => {
      active?.classList.remove("glass-lit");
      active?.style.removeProperty("--tilt-x");
      active?.style.removeProperty("--tilt-y");
      activeNav?.removeAttribute("data-glass-hover");
      active = activeNav = null;
      pending = null;
      resize.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const animate = () => {
      frame = 0;
      if (motion.matches) return;
      if (pending) {
        const event = pending;
        pending = null;
        const element = event.target instanceof Element ? event.target : null;
        const surface = element?.closest<HTMLElement>(GLASS_SURFACES) ?? null;
        if (surface !== active) {
          active?.classList.remove("glass-lit");
          active?.style.removeProperty("--tilt-x");
          active?.style.removeProperty("--tilt-y");
          resize.disconnect();
          active = surface;
          if (surface) {
            prepare(surface);
            surface.classList.add("glass-lit");
            updateRefraction();
            resize.observe(surface);
          }
        }
        if (surface) {
          const rect = surface.getBoundingClientRect();
          targetX = Math.max(
            0,
            Math.min(
              100,
              ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
            ),
          );
          targetY = Math.max(
            0,
            Math.min(
              100,
              ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100,
            ),
          );
        }
        // The pointer is the light: every rim brightens on the side facing it.
        const vx = window.innerWidth / 2 - event.clientX;
        const vy = window.innerHeight / 2 - event.clientY;
        if (Math.hypot(vx, vy) > 24) {
          const next = (Math.atan2(vx, -vy) * 180) / Math.PI;
          targetAngle = angle + ((((next - angle) % 360) + 540) % 360) - 180;
        }
        const control = element?.closest<HTMLElement>(GLASS_CONTROLS);
        if (control) {
          const box = control.getBoundingClientRect();
          control.style.setProperty("--px", `${event.clientX - box.left}px`);
          control.style.setProperty("--py", `${event.clientY - box.top}px`);
        }
        const link = element?.closest<HTMLElement>(".sidebar nav > a");
        const nav = link?.parentElement ?? null;
        if (nav !== activeNav) activeNav?.removeAttribute("data-glass-hover");
        activeNav = nav;
        if (link && nav) {
          nav.style.setProperty("--nav-y", `${link.offsetTop}px`);
          nav.style.setProperty("--nav-height", `${link.offsetHeight}px`);
          nav.style.setProperty("--nav-width", `${link.offsetWidth}px`);
          nav.setAttribute("data-glass-hover", "true");
        }
      }
      let moving = false;
      angle += (targetAngle - angle) * 0.14;
      if (Math.abs(targetAngle - angle) > 0.3) moving = true;
      root.style.setProperty("--light-angle", `${angle.toFixed(1)}deg`);
      if (active) {
        x += (targetX - x) * 0.24;
        y += (targetY - y) * 0.24;
        active.style.setProperty("--glass-x", `${x.toFixed(2)}%`);
        active.style.setProperty("--glass-y", `${y.toFixed(2)}%`);
        if (active.matches(TILT_SURFACES)) {
          active.style.setProperty("--tilt-x", `${((50 - y) / 50) * 4}deg`);
          active.style.setProperty("--tilt-y", `${((x - 50) / 50) * 5}deg`);
        }
        if (Math.abs(x - targetX) + Math.abs(y - targetY) > 0.15) moving = true;
      }
      if (moving) frame = requestAnimationFrame(animate);
    };
    const move = (event: PointerEvent) => {
      if (motion.matches || event.pointerType !== "mouse") return;
      pending = event;
      if (!frame) frame = requestAnimationFrame(animate);
    };

    let jelly: { element: HTMLElement; x: number; y: number } | null = null;
    let jellyEvent: PointerEvent | null = null;
    let jellyFrame = 0;
    const stretch = () => {
      jellyFrame = 0;
      if (!jelly || !jellyEvent) return;
      const tx = pull(jellyEvent.clientX - jelly.x, 9);
      const ty = pull(jellyEvent.clientY - jelly.y, 7);
      const sx = Math.abs(tx) / 9,
        sy = Math.abs(ty) / 7;
      const style = jelly.element.style;
      style.setProperty("--jx", `${tx.toFixed(2)}px`);
      style.setProperty("--jy", `${ty.toFixed(2)}px`);
      style.setProperty("--jsx", `${(1 + sx * 0.09 - sy * 0.04).toFixed(3)}`);
      style.setProperty("--jsy", `${(1 + sy * 0.09 - sx * 0.04).toFixed(3)}`);
    };
    const release = () => {
      if (!jelly) return;
      const style = jelly.element.style;
      jelly.element.removeAttribute("data-pressing");
      for (const name of ["--jx", "--jy", "--jsx", "--jsy"])
        style.removeProperty(name);
      jelly = jellyEvent = null;
      cancelAnimationFrame(jellyFrame);
      jellyFrame = 0;
    };
    const drag = (event: PointerEvent) => {
      if (!jelly) return;
      jellyEvent = event;
      if (!jellyFrame) jellyFrame = requestAnimationFrame(stretch);
    };

    const press = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      // Touch has no hover, so the press itself decides where the glass lights up.
      const pressed = element?.closest<HTMLElement>(GLASS_CONTROLS);
      if (pressed) {
        const box = pressed.getBoundingClientRect();
        pressed.style.setProperty("--px", `${event.clientX - box.left}px`);
        pressed.style.setProperty("--py", `${event.clientY - box.top}px`);
      }
      if (motion.matches || event.button !== 0) return;
      const target = element?.closest<HTMLElement>(JELLY_CONTROLS);
      if (target) {
        release();
        jelly = { element: target, x: event.clientX, y: event.clientY };
        target.setAttribute("data-pressing", "");
      }
      if (!ripples.current) return;
      const ring = document.createElement("span");
      ring.className = "liquid-ripple";
      ring.style.left = `${event.clientX}px`;
      ring.style.top = `${event.clientY}px`;
      while (ripples.current.childElementCount >= 4)
        ripples.current.firstElementChild?.remove();
      ripples.current.appendChild(ring);
      ring.addEventListener("animationend", () => ring.remove(), {
        once: true,
      });
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget) clear();
    };
    const preference = () => {
      if (motion.matches) {
        clear();
        release();
        ripples.current?.replaceChildren();
      }
    };

    // Thumbs follow the active tab; glass surfaces and lenses are set up as they mount.
    const placed = new WeakMap<HTMLElement, Box>();
    let syncFrame = 0;
    const place = (host: HTMLElement, box: Box) =>
      Object.entries(boxCss(box)).forEach(([key, value]) =>
        host.style.setProperty(`--thumb-${key}`, value),
      );
    const sync = (animateThumbs: boolean) => {
      syncFrame = 0;
      for (const surface of document.querySelectorAll<HTMLElement>(
        GLASS_SURFACES,
      ))
        prepare(surface);
      for (const node of prepared.keys())
        if (!node.isConnected) prepared.delete(node);
      if (lensSupported) {
        for (const surface of document.querySelectorAll<HTMLElement>(
          LENS_SURFACES,
        ))
          attachLens(surface);
        for (const [surface, lens] of lenses)
          if (!surface.isConnected) {
            lensResize.unobserve(surface);
            lens.filter.remove();
            lenses.delete(surface);
          }
      }
      for (const host of document.querySelectorAll<HTMLElement>(THUMB_HOSTS)) {
        const current = host.querySelector<HTMLElement>(":scope > .active");
        if (!current || !current.offsetWidth) {
          host.removeAttribute("data-thumb");
          placed.delete(host);
          continue;
        }
        const to: Box = {
          x: current.offsetLeft,
          y: current.offsetTop,
          w: current.offsetWidth,
          h: current.offsetHeight,
        };
        const from = placed.get(host);
        if (
          from &&
          from.x === to.x &&
          from.y === to.y &&
          from.w === to.w &&
          from.h === to.h
        )
          continue;
        placed.set(host, to);
        place(host, to);
        host.setAttribute("data-thumb", "");
        if (!from || !animateThumbs || motion.matches) continue;
        host.animate(
          [
            { ...boxCss(from), offset: 0 },
            {
              ...boxCss(stretched(from, to)),
              offset: 0.38,
              easing: "cubic-bezier(.25,.9,.35,1)",
            },
            { ...boxCss(to), offset: 1 },
          ],
          {
            duration: 560,
            easing: "cubic-bezier(.3,1.25,.5,1)",
            pseudoElement: "::after",
          },
        );
      }
    };
    const schedule = () => {
      if (!syncFrame) syncFrame = requestAnimationFrame(() => sync(true));
    };
    const relayout = () => {
      cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => sync(false));
    };
    // Only class and tree changes can move an active tab; style writes are ignored.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointermove", drag, { passive: true });
    window.addEventListener("pointerdown", press, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener("pointerout", leave, { passive: true });
    window.addEventListener("blur", clear);
    window.addEventListener("blur", release);
    window.addEventListener("resize", relayout);
    motion.addEventListener("change", preference);
    document.fonts?.ready.then(relayout);
    sync(false);
    return () => {
      clear();
      release();
      observer.disconnect();
      lensResize.disconnect();
      cancelAnimationFrame(syncFrame);
      for (const [surface, position] of prepared) {
        surface.classList.remove("glass-ready");
        surface.style.position = position;
        surface.style.removeProperty("--glass-x");
        surface.style.removeProperty("--glass-y");
      }
      for (const surface of lenses.keys()) {
        surface.removeAttribute("data-lens");
        surface.style.removeProperty("--lens");
      }
      lensDefs.remove();
      root.style.removeProperty("--light-angle");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", clear);
      window.removeEventListener("blur", release);
      window.removeEventListener("resize", relayout);
      motion.removeEventListener("change", preference);
    };
  }, []);

  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelector(".main-content")?.animate(
      [
        {
          opacity: 0,
          transform: "translateY(12px) scale(0.992)",
          filter: "blur(5px)",
        },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 460, easing: "cubic-bezier(.22,1,.36,1)" },
    );
  }, [location.pathname]);

  return (
    <>
      <div className="liquid-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <svg
        className="liquid-filter-defs"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <filter
            id="liquid-edge-refraction"
            x="0"
            y="0"
            width="1"
            height="1"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              ref={displacement}
              x="0"
              y="0"
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              result="edgeMap"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="edgeMap"
              scale="18"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
      {createPortal(
        <div ref={ripples} className="liquid-ripples" aria-hidden="true" />,
        document.body,
      )}
    </>
  );
}
