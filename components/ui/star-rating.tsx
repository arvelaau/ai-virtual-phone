"use client";

import { Star } from "lucide-react";

const STAR_COLOR = "#ffb800";

/**
 * A 5-star rating display/input, supporting half-star steps (0.5-5.0). Read-only mode is used
 * for a character's own published review (never user-editable); interactive mode is used for
 * the user's own personal rating on a title.
 */
export function StarRating({
  value,
  onChange,
  size = 18,
  readOnly = false,
}: {
  value: number;
  onChange?: (next: number) => void;
  size?: number;
  readOnly?: boolean;
}) {
  const stars = [1, 2, 3, 4, 5];

  const handleClick = (starIndex: number, half: boolean) => {
    if (readOnly || !onChange) return;
    const next = half ? starIndex - 0.5 : starIndex;
    onChange(next);
  };

  return (
    <div className="ui-star-rating" role={readOnly ? undefined : "group"} aria-label={readOnly ? undefined : "Set rating"}>
      {stars.map((starIndex) => {
        const fillLevel = Math.min(1, Math.max(0, value - (starIndex - 1)));
        return (
          <span
            key={starIndex}
            className="ui-star-rating-star"
            style={{ position: "relative", display: "inline-block", width: size, height: size, cursor: readOnly ? undefined : "pointer" }}
          >
            <Star size={size} color={STAR_COLOR} fill="none" style={{ position: "absolute", inset: 0 }} />
            <span style={{ position: "absolute", inset: 0, overflow: "hidden", width: `${fillLevel * 100}%` }}>
              <Star size={size} color={STAR_COLOR} fill={STAR_COLOR} />
            </span>
            {!readOnly && (
              <>
                <button
                  type="button"
                  aria-label={`${starIndex - 0.5} stars`}
                  onClick={() => handleClick(starIndex, true)}
                  style={{ position: "absolute", inset: 0, width: "50%", left: 0, background: "none", border: "none", padding: 0 }}
                />
                <button
                  type="button"
                  aria-label={`${starIndex} stars`}
                  onClick={() => handleClick(starIndex, false)}
                  style={{ position: "absolute", inset: 0, width: "50%", left: "50%", background: "none", border: "none", padding: 0 }}
                />
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}
