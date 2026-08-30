import { useEffect, useRef } from 'react';

/**
 * WarpField — the Warp Intake signature canvas (the locked site direction).
 *
 * mode="hero"    : the full vortex — light particles spiralling out of the
 *                  dark into a glowing intake ring. Positioned absolutely
 *                  inside the hero section.
 * mode="ambient" : a sparse star field drifting almost imperceptibly toward
 *                  the centre of the screen. Fixed behind every page.
 *
 * Hand-rolled 2D canvas rather than three.js: ~1k particles is trivial at
 * 60fps and keeps the site dependency-free. The field pauses when offscreen
 * or the tab is hidden, renders one still frame under prefers-reduced-motion,
 * and silently does nothing where canvas is unavailable (jsdom, old UAs).
 */

const PALETTES = {
  dark: {
    near: [99, 220, 255], // brand-300 — particles close to the intake
    far: [150, 92, 244], // accent-500 — particles out in the dark
    ring: '43, 199, 255',
    ring2: '150, 92, 244',
    core: '213, 248, 255',
    alpha: 1,
    composite: 'lighter',
  },
  light: {
    near: [31, 86, 184],
    far: [107, 59, 196],
    ring: '31, 86, 184',
    ring2: '107, 59, 196',
    core: '90, 120, 220',
    alpha: 0.5,
    composite: 'source-over',
  },
};

const themeName = () =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

export default function WarpField({ mode = 'hero', className = '' }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const canvas = document.createElement('canvas');
    let ctx = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      /* environments without canvas */
    }
    if (!ctx) return undefined;
    host.appendChild(canvas);

    const reduced = !!(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const hero = mode === 'hero';

    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    let particles = [];
    let comets = [];
    let shoot = null;
    let t = Math.random() * 40;
    let nextShoot = t + 5 + Math.random() * 6;

    const newComet = () => ({
      r: 45 + Math.random() * 45,
      th: Math.random() * Math.PI * 2,
      y: (Math.random() - 0.5) * 10,
      sp: 26 + Math.random() * 16,
      px: 0,
      py: 0,
      fresh: true,
    });

    function seed() {
      particles = [];
      if (hero) {
        const n = Math.min(1000, Math.max(320, Math.round((w * h) / 1600)));
        for (let i = 0; i < n; i++) {
          particles.push({
            r: 8 + Math.random() * 74,
            th: Math.random() * Math.PI * 2,
            y: (Math.random() - 0.5) * 26,
            sp: 6 + Math.random() * 13,
            px: 0,
            py: 0,
            fresh: true,
          });
        }
        comets = [];
        for (let i = 0; i < 6; i++) comets.push(newComet());
      } else {
        const n = Math.min(170, Math.max(60, Math.round((w * h) / 11000)));
        for (let i = 0; i < n; i++) {
          particles.push({
            x: Math.random(),
            y: Math.random(),
            z: 0.25 + Math.random() * 0.75,
            ph: Math.random() * 6.28,
          });
        }
      }
    }

    function size() {
      const rect = host.getBoundingClientRect();
      w = Math.max(4, rect.width);
      h = Math.max(4, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    // Perspective projection of the tilted vortex plane.
    const TILT = 0.95;
    const COS = Math.cos(TILT);
    const SIN = Math.sin(TILT);
    const F = 480;
    function project(x, y, z, k, cx, cy) {
      const yc = y * COS - z * SIN;
      const zc = y * SIN + z * COS;
      const s = F / (F + zc * k);
      return [cx + x * k * s, cy + yc * k * s, s];
    }

    function drawHero(dt) {
      const pal = PALETTES[themeName()];
      ctx.clearRect(0, 0, w, h);
      const k = Math.min(w, h) / 118;
      const cx = w * 0.5 + Math.sin(t * 0.12) * 9;
      const cy = h * 0.46 + Math.sin(t * 0.2) * 5;

      // Core glow + the intake ring pair.
      const R = 9.5 * k;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.1);
      glow.addColorStop(0, `rgba(${pal.core}, ${0.32 * pal.alpha})`);
      glow.addColorStop(0.45, `rgba(${pal.ring}, ${0.12 * pal.alpha})`);
      glow.addColorStop(1, `rgba(${pal.ring}, 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(cx - R * 2.2, cy - R * 2.2, R * 4.4, R * 4.4);

      ctx.globalCompositeOperation = pal.composite;
      ctx.lineWidth = 1.8 + Math.sin(t * 1.3) * 0.5;
      ctx.strokeStyle = `rgba(${pal.ring}, ${(0.75 + Math.sin(t * 1.3) * 0.2) * pal.alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, R, R * 0.36, Math.sin(t * 0.4) * 0.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = `rgba(${pal.ring2}, ${0.5 * pal.alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * 1.5, R * 0.5, -Math.sin(t * 0.3) * 0.14, 0, Math.PI * 2);
      ctx.stroke();

      // Particles spiral inward, drawn as short streaks.
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.r -= p.sp * dt * (0.22 + (84 - p.r) * 0.008);
        p.th += dt * (15 / (p.r + 4));
        p.y *= 1 - 0.5 * dt;
        if (p.r < 2.6) {
          p.r = 58 + Math.random() * 26;
          p.th = Math.random() * Math.PI * 2;
          p.y = (Math.random() - 0.5) * 26;
          p.fresh = true;
        }
        const [sx, sy, s] = project(Math.cos(p.th) * p.r, p.y, Math.sin(p.th) * p.r, k, cx, cy);
        if (!p.fresh) {
          const mix = Math.min(1, p.r / 76);
          const c0 = pal.near;
          const c1 = pal.far;
          const cr = Math.round(c0[0] + (c1[0] - c0[0]) * mix);
          const cg = Math.round(c0[1] + (c1[1] - c0[1]) * mix);
          const cb = Math.round(c0[2] + (c1[2] - c0[2]) * mix);
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${(0.14 + 0.6 * (1 - mix)) * s * pal.alpha})`;
          ctx.lineWidth = 1.25 * s;
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        p.px = sx;
        p.py = sy;
        p.fresh = false;
      }

      // Comets: a handful of brighter, faster arrivals.
      for (let i = 0; i < comets.length; i++) {
        const c = comets[i];
        c.r -= c.sp * dt * (0.3 + (95 - c.r) * 0.006);
        c.th += dt * (22 / (c.r + 5));
        if (c.r < 3) {
          comets[i] = newComet();
          continue;
        }
        const [sx, sy, s] = project(Math.cos(c.th) * c.r, c.y, Math.sin(c.th) * c.r, k, cx, cy);
        if (!c.fresh) {
          ctx.strokeStyle = `rgba(${pal.near[0]}, ${pal.near[1]}, ${pal.near[2]}, ${0.75 * s * pal.alpha})`;
          ctx.lineWidth = 2.2 * s;
          ctx.beginPath();
          ctx.moveTo(c.px, c.py);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        c.px = sx;
        c.py = sy;
        c.fresh = false;
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawAmbient(dt) {
      const pal = PALETTES[themeName()];
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // A very slow pull toward the centre of the screen.
        p.x += (0.5 - p.x) * 0.0035 * p.z;
        p.y += (0.5 - p.y) * 0.0035 * p.z;
        if (Math.abs(p.x - 0.5) < 0.004 && Math.abs(p.y - 0.5) < 0.004) {
          p.x = Math.random();
          p.y = Math.random();
        }
        const tw = 0.55 + 0.45 * Math.sin(t * 0.8 + p.ph);
        const c = p.z > 0.6 ? pal.near : pal.far;
        ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${0.16 * p.z * tw * pal.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 0.6 + p.z * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // An occasional shooting star.
      const step = dt || 0.016;
      if (!shoot && t > nextShoot) {
        shoot = {
          x: 0.15 + Math.random() * 0.7,
          y: 0.05 + Math.random() * 0.3,
          vx: (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.18),
          vy: 0.1 + Math.random() * 0.08,
          life: 1,
        };
      }
      if (shoot) {
        shoot.x += shoot.vx * step;
        shoot.y += shoot.vy * step;
        shoot.life -= step / 0.9;
        const c = pal.near;
        ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, shoot.life) * 0.55 * pal.alpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo((shoot.x - shoot.vx * 0.07) * w, (shoot.y - shoot.vy * 0.07) * h);
        ctx.lineTo(shoot.x * w, shoot.y * h);
        ctx.stroke();
        if (shoot.life <= 0 || shoot.x < -0.1 || shoot.x > 1.1 || shoot.y > 1.1) {
          shoot = null;
          nextShoot = t + 6 + Math.random() * 8;
        }
      }
    }

    let last = 0;
    function frame(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
      last = now;
      t += dt;
      if (hero) drawHero(dt);
      else drawAmbient(dt);
      raf = requestAnimationFrame(frame);
    }
    function play() {
      if (reduced || raf || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function still() {
      // One legible frame for prefers-reduced-motion.
      if (hero) {
        for (let i = 0; i < 26; i++) {
          t += 1 / 30;
          drawHero(1 / 30);
        }
      } else {
        drawAmbient(0.016);
      }
    }

    size();
    if (reduced) still();
    else play();

    let io = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          visible = entries.some((e) => e.isIntersecting);
          if (visible) play();
          else if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
        },
        { threshold: 0 }
      );
      io.observe(host);
    }

    const onVis = () => {
      if (document.hidden) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      } else {
        play();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    let ro = null;
    let rt = 0;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        size();
        if (reduced) still();
      }, 150);
    };
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(host);
    } else {
      window.addEventListener('resize', onResize);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(rt);
      document.removeEventListener('visibilitychange', onVis);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', onResize);
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, [mode]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={`${mode === 'hero' ? 'warp-stage' : 'warp-ambient'} ${className}`.trim()}
    />
  );
}
