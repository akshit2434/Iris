# Iris UI standards

Iris is a quiet conversation space. The interface should feel continuous, tactile, and calm—not like a dashboard or a collection of cards.

## Visual language

- Use a cool white canvas with restrained blue, cyan, and lavender atmosphere.
- Keep primary text near-black. Reserve blue for focus, progress, and selected state.
- Prefer one continuous surface. Add containers only when they clarify an interaction or grouping.
- Use broad radii, translucent material, thin white borders, and soft directional shadows.
- Use the generated Iris aperture mark as the identity. Do not substitute icon-pack logos, stars, sparkles, robots, or magic motifs.
- Use Geist with tight display tracking and comfortable reading line-height.

## Procedural blur

- Fixed UI must dissolve into scrolling content instead of ending at a hard horizontal edge.
- Build top and bottom fades from overlapping masked blur bands. Increase blur gradually toward the fixed control.
- Put a translucent color wash behind the blur bands so the fallback remains legible.
- Use procedural blur around chat headers, composers, and the mobile dock. Do not place it behind ordinary static content.
- Preserve contrast and provide an opaque fallback when backdrop filters are unavailable.

## Interaction

- Keep one primary action per view.
- Prefer state changes, weight, color, motion, and haptics over redundant status sentences.
- Tap targets should be at least 44px. Primary mobile controls should sit within easy thumb reach.
- Motion should settle elements into place and clarify continuity. Avoid looping decoration and scroll spectacle.
- Respect `prefers-reduced-motion` and never make motion necessary to understand state.
- Loading indicators should be compact and local to the action that is waiting.

## Chat

- Chat is edge-to-edge and visually central.
- The title and composer float above the transcript with procedural edge blur.
- User messages may use a dark compact bubble. Assistant responses read directly on the canvas.
- Timestamps stay visually quiet but message IDs remain in the DOM for future exact-message links.
- Empty chat needs one prompt and one composer—no suggestions grid, dashboard, or instructional copy.

## Copy

- Write only text that supports a decision, input, result, or recovery.
- Avoid eyebrow labels, decorative taglines, repeated headings, helper text that restates a control, and fake status language.
- Empty and error states should be brief and actionable.

## Responsive behavior

- Design at mobile width first, including safe areas and the on-screen keyboard.
- Use a floating bottom dock on mobile and a quiet side rail on desktop.
- Hide global mobile navigation inside chat so the composer owns the bottom edge.
- Expand spacing and line length on larger screens without changing the core information architecture.
