# Carlson Taskmaster — Site Design

**Date:** 2026-06-14
**Status:** Approved

## Goal

A local, static website to host and share a family version of the game show
*Taskmaster* ("Carlson Taskmaster"). Styled after https://taskmaster.tv/.
Built so it can later be hosted publicly and extended with an interactive task
subpage per contestant.

## Build

- Plain static site: a single `index.html`, one `styles.css`, and the existing
  image assets. No build step, no dependencies — opens by double-click and
  drops onto any static host (Netlify, GitHub Pages, etc.).
- Folder layout leaves room for a future `tasks/` subpage directory; contestant
  cards are structured so they can later link to per-person task pages.

## Assets

- `kenny_taskmaster.png` — Kenny Carlson, the Taskmaster (gold throne, red velvet).
- `page_assistent.png` — Page West, the Taskmaster's assistant (red damask backdrop).
- Placeholder photos for the 5 contestants.

## Visual Style (per taskmaster.tv)

- Deep red background with a red *patterned* (damask) texture for the hero.
- Gold / cream accents; bold condensed display headings; dark sections for contrast.

## Sections

### 1. Welcome to Carlson Taskmaster (Hero)
- Red patterned background.
- `kenny_taskmaster.png` front and center inside an ornate **gold frame**.
- Title "CARLSON TASKMASTER" + short tagline. Kenny labeled **The Taskmaster**.

### 2. Meet the Taskmaster's Assistant
- Slim band introducing **Page West** using `page_assistent.png` (framed photo
  beside a one-line role description).

### 3. What is Taskmaster?
- A couple of sentences: contestants tackle silly/creative tasks, the Taskmaster
  judges and awards points, most points wins.

### 4. The Contestants (leaderboard-style grid)
- Card grid styled like the site's "current series leaderboard."
- **Photo (placeholder) + name only** for each:
  - Kathryn Carlson
  - Elizabeth Robb
  - Mike Robb
  - Lindsay Veazey
  - John Veazey
- Cards visually ready to later show scores and link to task subpages.

### Footer
- Small note; room to grow.

## Out of Scope (future)

- Interactive task subpages per contestant.
- Scores / leaderboard numbers.
- Public hosting setup.

## Notes

- Folder is not yet a git repo; the user will init and commit later.
