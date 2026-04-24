# Booky

App web para tomar notas por voz por proyecto, separando fragmentos por pausas de mas de 2 segundos, y analizando la idea de cada fragmento con OpenAI.

## Requisitos

- Node.js 18 o superior
- Una clave de OpenAI en `.env`
- Una base de datos Postgres (Neon recomendado)

## Configuracion

1. Instala dependencias:
   ```bash
   npm install
   ```
2. Crea tu archivo `.env` basado en `.env.example`:
   ```env
   OPENAI_API_KEY=tu_clave
   OPENAI_MODEL=gpt-4.1-mini
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   PORT=3000
   ```

## Ejecutar

```bash
npm run dev
```

Abre `http://localhost:3000`.

## Flujo de uso

1. Crea o selecciona un proyecto.
2. Pulsa `Activar microfono`.
3. Habla normalmente: la transcripcion aparece en vivo.
4. Si hay una pausa de mas de 2 segundos, Booky cierra un fragmento.
5. Ese fragmento se envia al backend y OpenAI devuelve la idea principal.
6. Todo queda guardado en Postgres (Neon).

## Settings

- Pestaña `Settings` para:
  - Elegir el modelo LLM (lista obtenida desde la API de OpenAI).
  - Editar el prompt de extraccion de ideas.
  - Editar el prompt del resumen automatico por bloques de 10.
- Los settings se guardan en la base de datos.

## Escalabilidad de fragmentos

- La lista de fragmentos trae solo ideas (sin texto completo).
- El texto completo de cada fragmento se carga bajo demanda al pulsar `Ver texto`.
- Paginacion de ideas: 20 fragmentos maximo por pagina.
- El analizador usa cache en memoria con los ultimos 3 textos del proyecto para dar mejor contexto sin consultar BD en cada request.
- Cada 10 fragmentos se genera automaticamente un resumen corto para mantener el hilo del libro.

## Notas

- En navegadores moviles, el permiso de microfono debe estar habilitado.
- El reconocimiento de voz usa Web Speech API (mejor soporte en Chrome/Edge basados en Chromium).
- Para Vercel, configura variables de entorno: `OPENAI_API_KEY`, `DATABASE_URL`, `OPENAI_MODEL`.
- `vercel.json` ya incluye la configuracion para desplegar el backend Express.
