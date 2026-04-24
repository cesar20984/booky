const PAUSE_MS = 2000;

const tabApp = document.getElementById("tabApp");
const tabSettings = document.getElementById("tabSettings");
const viewApp = document.getElementById("viewApp");
const viewSettings = document.getElementById("viewSettings");

const projectSelect = document.getElementById("projectSelect");
const createProjectForm = document.getElementById("createProjectForm");
const newProjectInput = document.getElementById("newProjectInput");
const micButton = document.getElementById("micButton");
const statusText = document.getElementById("statusText");
const liveTranscript = document.getElementById("liveTranscript");
const fragmentsList = document.getElementById("fragmentsList");
const fragmentTemplate = document.getElementById("fragmentTemplate");
const prevPageButton = document.getElementById("prevPageButton");
const nextPageButton = document.getElementById("nextPageButton");
const paginationText = document.getElementById("paginationText");

const modelSelect = document.getElementById("modelSelect");
const refreshModelsButton = document.getElementById("refreshModelsButton");
const ideaPromptInput = document.getElementById("ideaPromptInput");
const saveSettingsButton = document.getElementById("saveSettingsButton");
const settingsStatus = document.getElementById("settingsStatus");

let projects = [];
let selectedProjectId = "";
let fragments = [];
let currentPage = 1;
let totalPages = 1;
let selectedModel = "";
let settingsPrompts = { ideaPrompt: "" };

let listening = false;
let recognition = null;
let pauseTimer = null;
let currentBuffer = "";
let interimBuffer = "";

const textCache = new Map();

bootstrap();

async function bootstrap() {
  initSpeechRecognition();
  setActiveTab("app");
  await Promise.all([loadProjects(), loadSettings(), loadModels()]);
}

tabApp.addEventListener("click", () => setActiveTab("app"));
tabSettings.addEventListener("click", () => setActiveTab("settings"));

projectSelect.addEventListener("change", async () => {
  selectedProjectId = projectSelect.value;
  currentPage = 1;
  micButton.disabled = !selectedProjectId;

  if (!selectedProjectId) {
    stopListening();
    fragments = [];
    renderFragments();
    updatePagination();
    setStatus("Selecciona o crea un proyecto para empezar.");
    return;
  }

  setStatus("Proyecto cambiado. Listo para escuchar.");
  await loadFragments();
});

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = newProjectInput.value.trim();
  if (!name) return;

  try {
    const payload = await fetchJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    newProjectInput.value = "";
    await loadProjects(payload.project.id);
    setStatus(`Proyecto "${payload.project.name}" creado.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

micButton.addEventListener("click", () => {
  if (!recognition) {
    setStatus("Tu navegador no soporta reconocimiento de voz.", true);
    return;
  }

  if (listening) stopListening();
  else startListening();
});

prevPageButton.addEventListener("click", async () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  await loadFragments();
});

nextPageButton.addEventListener("click", async () => {
  if (currentPage >= totalPages) return;
  currentPage += 1;
  await loadFragments();
});

refreshModelsButton.addEventListener("click", async () => {
  await loadModels(true);
});

saveSettingsButton.addEventListener("click", async () => {
  const model = modelSelect.value;
  const ideaPrompt = ideaPromptInput.value.trim();
  if (!model) {
    setSettingsStatus("Selecciona un modelo.", true);
    return;
  }

  try {
    const payload = await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedModel: model,
        prompts: {
          ideaPrompt
        }
      })
    });

    selectedModel = payload.selectedModel;
    settingsPrompts = payload.prompts;
    ideaPromptInput.value = settingsPrompts.ideaPrompt || "";
    renderModelSelection();
    setSettingsStatus("Settings guardados.");
  } catch (error) {
    setSettingsStatus(error.message, true);
  }
});

function setActiveTab(tabName) {
  const isApp = tabName === "app";
  tabApp.classList.toggle("active", isApp);
  tabSettings.classList.toggle("active", !isApp);
  viewApp.classList.toggle("active", isApp);
  viewSettings.classList.toggle("active", !isApp);
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    let finalText = "";
    interimBuffer = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += `${transcript} `;
      else interimBuffer += `${transcript} `;
    }

    if (finalText.trim()) {
      currentBuffer += `${finalText.trim()} `;
      schedulePauseFlush();
    }

    updateLiveTranscript();
  };

  recognition.onerror = (event) => {
    setStatus(`Error de reconocimiento: ${event.error}`, true);
  };

  recognition.onend = () => {
    if (listening) {
      recognition.start();
      return;
    }
    micButton.textContent = "Activar microfono";
  };
}

function startListening() {
  if (!selectedProjectId) {
    setStatus("Selecciona un proyecto primero.", true);
    return;
  }

  listening = true;
  micButton.textContent = "Detener microfono";
  setStatus("Escuchando... pausa mas de 2s para cerrar fragmento.");
  try {
    recognition.start();
  } catch (_error) {
    // Ignore repeated start race conditions.
  }
}

function stopListening() {
  listening = false;
  clearPauseTimer();
  void flushCurrentBuffer();
  interimBuffer = "";
  updateLiveTranscript();

  if (recognition) recognition.stop();
  micButton.textContent = "Activar microfono";
  setStatus("Microfono detenido.");
}

function schedulePauseFlush() {
  clearPauseTimer();
  pauseTimer = setTimeout(() => {
    void flushCurrentBuffer();
  }, PAUSE_MS);
}

function clearPauseTimer() {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
}

async function flushCurrentBuffer() {
  const text = currentBuffer.trim();
  if (!text || !selectedProjectId) return;

  if (isDeleteCommand(text)) {
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/fragments/last`, {
        method: "DELETE"
      });
      if (response.status === 404) {
        setStatus("Comando 'Borrar' detectado, pero no habia fragmentos.");
      } else if (!response.ok) {
        const payload = await safeReadJson(response);
        throw new Error(payload?.error || "No se pudo borrar el ultimo fragmento.");
      } else {
        setStatus("Comando 'Borrar' detectado: se elimino el fragmento anterior.");
        textCache.clear();
        if (currentPage !== 1) currentPage = 1;
        await loadProjects(selectedProjectId);
        await loadFragments();
      }
    } catch (error) {
      setStatus(error.message, true);
    }

    currentBuffer = "";
    updateLiveTranscript();
    return;
  }

  currentBuffer = "";
  updateLiveTranscript();

  setStatus("Analizando fragmento con IA...");
  try {
    await fetchJson(`/api/projects/${selectedProjectId}/fragments/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    textCache.clear();
    currentPage = 1;
    await loadProjects(selectedProjectId);
    await loadFragments();
    setStatus("Fragmento guardado y analizado.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function updateLiveTranscript() {
  const text = `${currentBuffer}${interimBuffer}`.trim();
  liveTranscript.textContent = text || "...";
}

async function loadProjects(preferredProjectId = "") {
  try {
    const payload = await fetchJson("/api/projects");
    projects = payload.projects || [];
    renderProjectOptions();

    if (preferredProjectId) selectedProjectId = preferredProjectId;
    if (!selectedProjectId && projects.length) selectedProjectId = projects[0].id;
    if (!projects.find((project) => project.id === selectedProjectId)) {
      selectedProjectId = projects.length ? projects[0].id : "";
    }

    projectSelect.value = selectedProjectId;
    micButton.disabled = !selectedProjectId;

    if (selectedProjectId) {
      await loadFragments();
      setStatus("Proyecto listo. Puedes activar el microfono.");
    } else {
      fragments = [];
      renderFragments();
      updatePagination();
      setStatus("Selecciona o crea un proyecto para empezar.");
    }
  } catch (error) {
    projects = [];
    selectedProjectId = "";
    micButton.disabled = true;
    renderProjectOptions();
    fragments = [];
    renderFragments();
    updatePagination();
    setStatus(error.message, true);
  }
}

async function loadFragments() {
  try {
    if (!selectedProjectId) {
      fragments = [];
      renderFragments();
      updatePagination();
      return;
    }

    const payload = await fetchJson(
      `/api/projects/${selectedProjectId}/fragments?page=${encodeURIComponent(currentPage)}`
    );

    fragments = payload.fragments || [];
    currentPage = payload.page || 1;
    totalPages = payload.totalPages || 1;
    renderFragments();
    updatePagination();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderProjectOptions() {
  projectSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = projects.length ? "Selecciona un proyecto" : "No hay proyectos aun";
  projectSelect.appendChild(placeholder);

  projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} (${project.fragmentCount})`;
    projectSelect.appendChild(option);
  });
}

function renderFragments() {
  fragmentsList.innerHTML = "";
  if (!selectedProjectId) {
    fragmentsList.innerHTML = "<p class='status'>Aun no hay proyecto seleccionado.</p>";
    return;
  }

  if (!fragments.length) {
    fragmentsList.innerHTML = "<p class='status'>No hay ideas para esta pagina.</p>";
    return;
  }

  fragments.forEach((fragment) => {
    const node = fragmentTemplate.content.cloneNode(true);
    const time = node.querySelector(".fragment-time");
    const idea = node.querySelector(".fragment-idea");
    const toggleButton = node.querySelector(".fragment-toggle");
    const deleteButton = node.querySelector(".fragment-delete");
    const textBox = node.querySelector(".fragment-text-box");
    const textNode = node.querySelector(".fragment-text");

    time.textContent = formatTime(fragment.createdAt);
    idea.textContent = fragment.idea;
    if (fragment.status === "error") idea.classList.add("error");

    toggleButton.addEventListener("click", async () => {
      const isHidden = textBox.classList.contains("hidden");
      if (!isHidden) {
        textBox.classList.add("hidden");
        toggleButton.textContent = "Ver texto";
        return;
      }

      try {
        if (!textCache.has(fragment.id)) {
          textNode.textContent = "Cargando texto...";
          textBox.classList.remove("hidden");
          toggleButton.textContent = "Ocultar texto";
          const response = await fetch(`/api/fragments/${fragment.id}/text`);
          const payload = await safeReadJson(response);
          if (!response.ok) throw new Error(payload?.error || "No se pudo cargar texto.");
          textCache.set(fragment.id, payload.text || "");
        }

        textNode.textContent = textCache.get(fragment.id) || "(sin texto)";
        textBox.classList.remove("hidden");
        toggleButton.textContent = "Ocultar texto";
      } catch (error) {
        textNode.textContent = error.message;
        textNode.classList.add("error");
        textBox.classList.remove("hidden");
        toggleButton.textContent = "Ocultar texto";
      }
    });

    deleteButton.addEventListener("click", async () => {
      try {
        const response = await fetch(`/api/fragments/${fragment.id}`, { method: "DELETE" });
        if (!response.ok) {
          const payload = await safeReadJson(response);
          throw new Error(payload?.error || "No se pudo borrar fragmento.");
        }
        textCache.delete(fragment.id);
        await loadProjects(selectedProjectId);
        await loadFragments();
        setStatus("Fragmento borrado.");
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    fragmentsList.appendChild(node);
  });
}

function updatePagination() {
  paginationText.textContent = `Pagina ${currentPage} de ${totalPages}`;
  prevPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= totalPages;
}

async function loadSettings() {
  try {
    const payload = await fetchJson("/api/settings");
    selectedModel = payload.selectedModel || "";
    settingsPrompts = payload.prompts || { ideaPrompt: "" };
    ideaPromptInput.value = settingsPrompts.ideaPrompt || "";
    renderModelSelection();
  } catch (error) {
    setSettingsStatus(error.message, true);
  }
}

let availableModels = [];

async function loadModels(showMessage = false) {
  try {
    if (showMessage) setSettingsStatus("Cargando modelos...");
    const payload = await fetchJson("/api/models");
    availableModels = payload.models || [];
    renderModelSelection();
    if (showMessage) setSettingsStatus("Modelos actualizados.");
  } catch (error) {
    if (showMessage) setSettingsStatus(error.message, true);
    if (!availableModels.length) {
      modelSelect.innerHTML = "<option value=''>No disponible</option>";
    }
  }
}

function renderModelSelection() {
  modelSelect.innerHTML = "";
  if (!availableModels.length) {
    const option = document.createElement("option");
    option.value = selectedModel || "";
    option.textContent = selectedModel || "Sin modelos disponibles";
    modelSelect.appendChild(option);
    return;
  }

  availableModels.forEach((modelId) => {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    modelSelect.appendChild(option);
  });

  if (selectedModel && availableModels.includes(selectedModel)) {
    modelSelect.value = selectedModel;
  } else {
    selectedModel = availableModels[0];
    modelSelect.value = selectedModel;
  }
}

function formatTime(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString("es-CL", {
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

function setSettingsStatus(text, isError = false) {
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("error", isError);
}

function isDeleteCommand(text) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "");
  return normalized === "borrar";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await safeReadJson(response);
  if (!response.ok) {
    throw new Error(payload?.error || `Error HTTP ${response.status}`);
  }
  return payload || {};
}

async function safeReadJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      throw new Error(
        "El servidor devolvio HTML en vez de JSON. Reinicia Booky con 'npm run dev' para cargar la version nueva del backend."
      );
    }
    return null;
  }

  try {
    return await response.json();
  } catch (_error) {
    throw new Error("Respuesta JSON invalida del servidor.");
  }
}
