# Radar MLB

Web que muestra los partidos MLB del día con datos de TeamRankings.com:
posición en su división, % de victorias y racha; carreras, hits, jonrones y
outs lanzados por juego (local en casa / visita fuera); 3 marcadores posibles,
total de carreras y hándicap (spread).

## Estructura
- `public/index.html` — la página
- `netlify/functions/mlb.mjs` — lee TeamRankings y entrega `/api/mlb`
- `netlify.toml` — configuración de Netlify (no cambiar)

## Publicar
1. Crear repositorio nuevo en GitHub y subir arrastrando las carpetas `public` y `netlify`
   más los archivos `netlify.toml`, `package.json` y `README.md`. No hace falta main.yml.
2. Netlify → Add new site → Import from GitHub → elegir el repositorio → Deploy.
