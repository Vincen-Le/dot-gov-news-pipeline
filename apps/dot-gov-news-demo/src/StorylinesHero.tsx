import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Thumbnail } from "./api/contracts";

type HeroArtwork = Thumbnail | null;

export function StorylinesHero({
  artwork,
  children,
}: {
  artwork: HeroArtwork | undefined;
  children: ReactNode;
}) {
  const [active, setActive] = useState<HeroArtwork>(null);
  const [outgoing, setOutgoing] = useState<Thumbnail | null>(null);
  const activeRef = useRef<HeroArtwork>(null);
  const artworkUrl = artwork?.cardUrl ?? null;

  useEffect(() => {
    if (artwork === undefined) return;
    if (activeRef.current?.cardUrl === artworkUrl) return;

    setOutgoing(activeRef.current);
    setActive(artwork);
    activeRef.current = artwork;
  }, [artwork, artworkUrl]);

  return (
    <section className="page-intro">
      <div aria-hidden="true" className="storylines-hero-artwork">
        {outgoing === null ? null : (
          <img
            className="storylines-hero-image storylines-hero-image--outgoing"
            onAnimationEnd={() => setOutgoing(null)}
            src={outgoing.cardUrl}
            style={{
              objectPosition: `${outgoing.focalX * 100}% ${outgoing.focalY * 100}%`,
            }}
          />
        )}
        {active === null ? null : (
          <img
            className="storylines-hero-image storylines-hero-image--incoming"
            decoding="async"
            fetchPriority="high"
            key={active.cardUrl}
            src={active.cardUrl}
            style={{
              objectPosition: `${active.focalX * 100}% ${active.focalY * 100}%`,
            }}
          />
        )}
      </div>
      {children}
    </section>
  );
}
