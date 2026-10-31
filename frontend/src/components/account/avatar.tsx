"use client";

import { useState } from "react";
import { initialsFor } from "@/lib/auth-client";

/**
 * A signed-in person's avatar: their Google photo when there is one,
 * otherwise their initials on the APEX flame.
 *
 * A plain `<img>`, not `next/image`. Routing a Google photo through the image
 * optimiser would mean adding `lh3.googleusercontent.com` to
 * `images.remotePatterns` and having our server fetch and re-encode a 96px
 * picture on every cache miss, for no visual gain. The browser loads it
 * straight from Google instead, which is why that host is in the CSP's
 * `img-src`.
 *
 * `referrerPolicy="no-referrer"`: Google's avatar CDN has been seen refusing
 * hot-linked requests that carry a third-party Referer, and there is no
 * reason to tell Google which APEX page the viewer is on anyway.
 *
 * The initials fallback also covers a photo that fails to load (an expired
 * URL, a blocked host), so the control never collapses into an empty circle.
 */
export default function Avatar({
  name,
  email,
  image,
  size = 32,
}: {
  name?: string | null;
  email?: string;
  image?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(image) && !failed;

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-primary-container text-[#1a1210] font-bold shadow-[0_0_0_1px_rgba(255,255,255,0.14)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- see the docblock
        <img
          src={image as string}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        initialsFor(name, email)
      )}
    </span>
  );
}
