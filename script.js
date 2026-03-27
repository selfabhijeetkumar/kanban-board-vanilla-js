/**
 * script.js — KanbanFlow
 *
 * Modular vanilla JavaScript for a full-featured Kanban Board.
 *
 * Architecture:
 *   1.  Firebase config & initialisation (with localStorage fallback)
 *   2.  Auth module  — signUp / login / logout / onAuthChange
 *   3.  Storage module — Firestore (cloud) or localStorage (guest)
 *   4.  Task CRUD    — addTask / deleteTask / updateTaskStatus / editTask
 *   5.  Drag & Drop  — handleDragStart / handleDragOver / handleDrop
 *   6.  UI rendering — renderTasks / createTaskElement / updateCounts
 *   7.  Modal helpers
 *   8.  Toast notifications
 *   9.  Search / filter
 *  10.  Event wiring
 *  11.  Boot
 *
 * FIREBASE SETUP (optional — app works without it in guest mode):
 *   1. Go to https://console.firebase.google.com and create a project.
 *   2. Enable Authentication → Email/Password.
 *   3. Enable Firestore Database (start in test mode, then add security rules).
 *   4. Register a web app and copy your firebaseConfig values below.
 *   5. Add Firestore security rules (see bottom of this file).
 *
 * OPTIONAL ENHANCEMENTS (search the file for "ENHANCEMENT"):
 *   - Edit task inline
 *   - Due-date overdue highlighting (already implemented)
 *   - Priority labels  (already implemented)
 *   - Drag-to-reorder within a column
 *   - Dark / light mode toggle
 */

/* ============================================================
   1. FIREBASE CONFIGURATION
   Replace the placeholder values with your own Firebase project
   credentials. Leave them as-is to use guest / localStorage mode.
============================================================ */
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

/* ============================================================
   2. GLOBALS
============================================================ */
/** @type {string | null} Current authenticated user id (null = guest) */
let currentUserId = null;

/** @type {boolean} Whether Firebase is properly configured and usable */
let firebaseEnabled = false;

/** @type {firebase.auth.Auth | null} */
let firebaseAuth = null;

/** @type {firebase.firestore.Firestore | null} */
let firebaseDB = null;

/** @type {Function | null} Firestore real-time listener unsubscribe fn */
let firestoreUnsubscribe = null;

/**
 * In-memory task store.
 * Key: task id (string), Value: Task object.
 * @type {Map<string, Task>}
 */
let taskStore = new Map();

/**
 * The task id currently being dragged.
 * @type {string | null}
 */
let draggedTaskId = null;

/**
 * The task id currently targeted for deletion.
 * @type {string | null}
 */
let pendingDeleteId = null;

/** Current search query string */
let searchQuery = "";

/* ============================================================
   3. DATA TYPES (JSDoc)
============================================================ */
/**
 * @typedef {Object} Task
 * @property {string}  id          — Unique identifier (UUID or Firestore doc id)
 * @property {string}  title       — Task title (required)
 * @property {string}  description — Optional description
 * @property {'todo'|'progress'|'done'} status — Column status
 * @property {'low'|'medium'|'high'}   priority — Priority level
 * @property {string}  category    — Category label
 * @property {string}  dueDate     — ISO date string (yyyy-mm-dd) or ""
 * @property {number}  createdAt   — Unix timestamp ms
 */

/* ============================================================
   4. FIREBASE INITIALISATION
============================================================ */
/**
 * Tries to initialise Firebase. If the config is not set (placeholder
 * values) or if the SDK fails, the app silently falls back to guest mode.
 */
function initFirebase() {
  try {
    // Detect unconfigured placeholder values
    if (
      FIREBASE_CONFIG.apiKey === "YOUR_API_KEY" ||
      !FIREBASE_CONFIG.projectId ||
      FIREBASE_CONFIG.projectId === "YOUR_PROJECT_ID"
    ) {
      console.info("Firebase not configured — running in guest/localStorage mode.");
      return;
    }

    firebase.initializeApp(FIREBASE_CONFIG);
    firebaseAuth = firebase.auth();
    firebaseDB   = firebase.firestore();
    firebaseEnabled = true;
    console.info("Firebase initialised.");
  } catch (err) {
    console.warn("Firebase init failed:", err.message, "— falling back to localStorage.");
  }
}

/* ============================================================
   5. AUTH MODULE
============================================================ */

/**
 * Register a new user with email + password.
 * @param {string} email
 * @param {string} password
 * @param {string} displayName
 */
async function signUp(email, password, displayName) {
  const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
  await cred.user.updateProfile({ displayName });
  return cred.user;
}

/**
 * Sign in an existing user.
 * @param {string} email
 * @param {string} password
 */
async function login(email, password) {
  const cred = await firebaseAuth.signInWithEmailAndPassword(email, password);
  return cred.user;
}

/**
 * Sign out the current user.
 */
async function logout() {
  if (firebaseEnabled && firebaseAuth) {
    await firebaseAuth.signOut();
  }
  // Clear in-memory state
  currentUserId = null;
  taskStore.clear();
  if (firestoreUnsubscribe) { firestoreUnsubscribe(); firestoreUnsubscribe = null; }
  showAuthScreen();
}

/**
 * Listen for Firebase Auth state changes.
 * Called once during boot.
 */
function onAuthChange() {
  if (!firebaseEnabled) return;

  firebaseAuth.onAuthStateChanged((user) => {
    if (user) {
      currentUserId = user.uid;
      document.getElementById("user-display").textContent =
        user.displayName || user.email;
      showApp();
      listenToTasks();
    } else {
      currentUserId = null;
      showAuthScreen();
    }
  });
}

/* ============================================================
   6. STORAGE MODULE — Firestore + localStorage
============================================================ */

/**
 * Returns the localStorage key for the current session.
 * Guest users share "kanban_tasks_guest"; logged-in users get a
 * per-uid key so their data is preserved across sessions without Firebase.
 * @returns {string}
 */
function lsKey() {
  return currentUserId
    ? `kanban_tasks_${currentUserId}`
    : "kanban_tasks_guest";
}

/**
 * Persist the current taskStore to localStorage.
 * Always called as a backup even when Firestore is in use.
 */
function saveTasks() {
  const tasks = Array.from(taskStore.values());
  try {
    localStorage.setItem(lsKey(), JSON.stringify(tasks));
  } catch (err) {
    console.warn("localStorage write failed:", err);
  }
}

/**
 * Load tasks from localStorage into taskStore.
 * @returns {Task[]}
 */
function loadTasksFromLocalStorage() {
  try {
    const raw = localStorage.getItem(lsKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Subscribe to real-time Firestore updates for the current user's tasks.
 * The UI is re-rendered every time data changes on the server.
 */
function listenToTasks() {
  if (!firebaseEnabled || !firebaseDB || !currentUserId) return;

  // Unsubscribe any previous listener first
  if (firestoreUnsubscribe) { firestoreUnsubscribe(); }

  firestoreUnsubscribe = firebaseDB
    .collection("users")
    .doc(currentUserId)
    .collection("tasks")
    .orderBy("createdAt", "asc")
    .onSnapshot(
      (snapshot) => {
        taskStore.clear();
        snapshot.forEach((doc) => {
          taskStore.set(doc.id, { id: doc.id, ...doc.data() });
        });
        saveTasks();       // keep localStorage in sync as a backup
        renderTasks();
      },
      (err) => {
        console.error("Firestore snapshot error:", err);
        showToast("Real-time sync error — changes saved locally.", "warn");
      }
    );
}

/**
 * Add a task document to Firestore.
 * @param {Task} task
 */
async function addTaskToDB(task) {
  const docRef = firebaseDB
    .collection("users")
    .doc(currentUserId)
    .collection("tasks")
    .doc(task.id);
  await docRef.set(task);
}

/**
 * Delete a task document from Firestore.
 * @param {string} taskId
 */
async function deleteTaskFromDB(taskId) {
  await firebaseDB
    .collection("users")
    .doc(currentUserId)
    .collection("tasks")
    .doc(taskId)
    .delete();
}

/**
 * Update the status field of a task in Firestore.
 * @param {string} taskId
 * @param {'todo'|'progress'|'done'} newStatus
 */
async function updateTaskStatusInDB(taskId, newStatus) {
  await firebaseDB
    .collection("users")
    .doc(currentUserId)
    .collection("tasks")
    .doc(taskId)
    .update({ status: newStatus });
}

/**
 * Update any fields of a task in Firestore.
 * @param {string} taskId
 * @param {Partial<Task>} updates
 */
async function updateTaskInDB(taskId, updates) {
  await firebaseDB
    .collection("users")
    .doc(currentUserId)
    .collection("tasks")
    .doc(taskId)
    .update(updates);
}

/* ============================================================
   7. TASK CRUD
============================================================ */

/**
 * Generate a simple unique id.
 * Uses crypto.randomUUID if available, otherwise a timestamp+random string.
 * @returns {string}
 */
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Add a new task.
 * @param {Object} fields - { title, description, status, priority, category, dueDate }
 */
async function addTask({ title, description, status, priority, category, dueDate }) {
  const id = generateId();
  /** @type {Task} */
  const task = {
    id,
    title:       title.trim(),
    description: description.trim(),
    status,
    priority:    priority || "medium",
    category:    category || "Other",
    dueDate:     dueDate  || "",
    createdAt:   Date.now(),
  };

  taskStore.set(id, task);

  if (firebaseEnabled && currentUserId) {
    try {
      await addTaskToDB(task);
      // Firestore listener will call renderTasks() automatically
    } catch (err) {
      console.error("Firestore add failed:", err);
      showToast("Saved locally (sync failed).", "warn");
      saveTasks();
      renderTasks();
    }
  } else {
    saveTasks();
    renderTasks();
  }

  showToast("Task added.", "success");
}

/**
 * Delete a task by id.
 * @param {string} taskId
 */
async function deleteTask(taskId) {
  taskStore.delete(taskId);

  if (firebaseEnabled && currentUserId) {
    try {
      await deleteTaskFromDB(taskId);
    } catch (err) {
      console.error("Firestore delete failed:", err);
      showToast("Deleted locally (sync failed).", "warn");
      saveTasks();
      renderTasks();
    }
  } else {
    saveTasks();
    renderTasks();
  }

  showToast("Task deleted.", "success");
}

/**
 * Update the status of a task (after drag-and-drop or a UI action).
 * @param {string} taskId
 * @param {'todo'|'progress'|'done'} newStatus
 */
async function updateTaskStatus(taskId, newStatus) {
  const task = taskStore.get(taskId);
  if (!task || task.status === newStatus) return;

  task.status = newStatus;
  taskStore.set(taskId, task);

  if (firebaseEnabled && currentUserId) {
    try {
      await updateTaskStatusInDB(taskId, newStatus);
    } catch (err) {
      console.error("Firestore status update failed:", err);
      saveTasks();
      renderTasks();
    }
  } else {
    saveTasks();
    renderTasks();
  }
}

/**
 * Edit / update a task's fields.
 * @param {string} taskId
 * @param {Partial<Task>} updates
 */
async function editTask(taskId, updates) {
  const task = taskStore.get(taskId);
  if (!task) return;

  const updatedTask = { ...task, ...updates };
  taskStore.set(taskId, updatedTask);

  if (firebaseEnabled && currentUserId) {
    try {
      await updateTaskInDB(taskId, updates);
    } catch (err) {
      console.error("Firestore edit failed:", err);
      saveTasks();
      renderTasks();
    }
  } else {
    saveTasks();
    renderTasks();
  }

  showToast("Task updated.", "success");
}

/* ============================================================
   8. DRAG & DROP
============================================================ */

/**
 * Called when the user starts dragging a task card.
 * Stores the dragged task's id in the DataTransfer object.
 * @param {DragEvent} e
 * @param {string} taskId
 */
function handleDragStart(e, taskId) {
  draggedTaskId = taskId;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", taskId);

  // Add dragging class after a tick so the ghost image looks correct
  requestAnimationFrame(() => {
    const el = document.getElementById(`task-${taskId}`);
    if (el) el.classList.add("dragging");
  });
}

/**
 * Called continuously while a draggable element is over a drop target.
 * Enables drop and shows a visual placeholder.
 * @param {DragEvent} e
 * @param {HTMLElement} column
 */
function handleDragOver(e, column) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  column.classList.add("drag-over");

  // Show drop placeholder
  let placeholder = document.getElementById("drop-placeholder");
  if (!placeholder) {
    placeholder = document.createElement("li");
    placeholder.id = "drop-placeholder";
    placeholder.className = "drop-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
  }

  const list = column.querySelector(".task-list");
  // Find insertion point based on mouse position
  const afterElement = getDragAfterElement(list, e.clientY);
  if (afterElement) {
    list.insertBefore(placeholder, afterElement);
  } else {
    list.appendChild(placeholder);
  }
}

/**
 * Find the element that the dragged card should be inserted before,
 * based on the vertical cursor position within the list.
 * Returns undefined when the dragged item should be placed at the end —
 * the caller's `if (afterElement)` guard handles this correctly.
 * @param {HTMLElement} list
 * @param {number} y - clientY of the drag event
 * @returns {HTMLElement | undefined}
 */
function getDragAfterElement(list, y) {
  const draggableItems = Array.from(
    list.querySelectorAll(".task-card:not(.dragging)")
  );

  // reduce finds the card whose top-half is closest below the cursor.
  // When no card qualifies (cursor is below all cards), element is undefined,
  // which causes the caller to append the placeholder at the list's end.
  return draggableItems.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child.closest("li") };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

/**
 * Called when the draggable element leaves a drop target.
 * @param {HTMLElement} column
 */
function handleDragLeave(column) {
  column.classList.remove("drag-over");
  removePlaceholder();
}

/**
 * Called when a dragged task is dropped on a column.
 * Updates the task's status and triggers a save.
 * @param {DragEvent} e
 * @param {HTMLElement} column
 */
async function handleDrop(e, column) {
  e.preventDefault();
  column.classList.remove("drag-over");
  removePlaceholder();

  const id      = e.dataTransfer.getData("text/plain") || draggedTaskId;
  const newStatus = column.dataset.status;

  if (!id || !newStatus) return;

  // Remove dragging style from original card
  const draggingEl = document.querySelector(".task-card.dragging");
  if (draggingEl) draggingEl.classList.remove("dragging");

  draggedTaskId = null;

  await updateTaskStatus(id, newStatus);
}

/** Clean up global drag state when drag ends without a drop. */
function handleDragEnd() {
  draggedTaskId = null;
  const draggingEl = document.querySelector(".task-card.dragging");
  if (draggingEl) draggingEl.classList.remove("dragging");
  removePlaceholder();
  document.querySelectorAll(".column").forEach((c) =>
    c.classList.remove("drag-over")
  );
}

/** Remove the drag placeholder element if it exists. */
function removePlaceholder() {
  const placeholder = document.getElementById("drop-placeholder");
  if (placeholder) placeholder.remove();
}

/* ============================================================
   9. UI RENDERING
============================================================ */

/**
 * Re-render all three column task lists from taskStore,
 * applying the current search filter.
 */
function renderTasks() {
  const statuses = ["todo", "progress", "done"];
  const q = searchQuery.toLowerCase().trim();

  statuses.forEach((status) => {
    const list = document.getElementById(`list-${status}`);
    if (!list) return;

    // Get tasks for this column, sorted oldest-first
    let tasks = Array.from(taskStore.values())
      .filter((t) => t.status === status)
      .sort((a, b) => a.createdAt - b.createdAt);

    // Apply search filter
    if (q) {
      tasks = tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (t.category || "").toLowerCase().includes(q)
      );
    }

    list.innerHTML = "";

    if (tasks.length === 0) {
      // Empty state message
      const empty = document.createElement("li");
      empty.className = "task-empty";
      empty.setAttribute("aria-label", "No tasks");
      empty.style.cssText =
        "color:var(--text-muted);font-size:0.8rem;text-align:center;padding:20px 0;";
      empty.textContent = q ? "No matching tasks." : "No tasks yet — add one!";
      list.appendChild(empty);
    } else {
      tasks.forEach((task) => {
        const li = document.createElement("li");
        li.appendChild(createTaskElement(task));
        list.appendChild(li);
      });
    }
  });

  updateCounts();
}

/**
 * Create and return a DOM element representing a single task card.
 * @param {Task} task
 * @returns {HTMLElement} The task card div
 */
function createTaskElement(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.id        = `task-${task.id}`;
  card.setAttribute("draggable", "true");
  card.setAttribute("role", "listitem");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `Task: ${task.title}. Priority: ${task.priority}. Status: ${task.status}.`);

  // ── Card Header (title + action buttons) ──
  const header = document.createElement("div");
  header.className = "card-header";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = task.title;

  // Action buttons (edit + delete)
  const actions = document.createElement("div");
  actions.className = "card-actions";

  // Edit button
  const editBtn = document.createElement("button");
  editBtn.className = "btn-icon";
  editBtn.innerHTML = "&#9998;"; // ✎
  editBtn.setAttribute("aria-label", `Edit task: ${task.title}`);
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditModal(task.id);
  });

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.className = "btn-icon";
  delBtn.innerHTML = "&#128465;"; // 🗑
  delBtn.setAttribute("aria-label", `Delete task: ${task.title}`);
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDeleteModal(task.id);
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  header.appendChild(title);
  header.appendChild(actions);

  // ── Description ──
  if (task.description) {
    const desc = document.createElement("p");
    desc.className = "card-description";
    desc.textContent = task.description;
    card.appendChild(header);
    card.appendChild(desc);
  } else {
    card.appendChild(header);
  }

  // ── Meta row: priority badge + category + due date ──
  const meta = document.createElement("div");
  meta.className = "card-meta";

  // Priority badge
  const priorityBadge = document.createElement("span");
  priorityBadge.className = `badge badge-${task.priority || "medium"}`;
  priorityBadge.textContent = (task.priority || "medium");
  meta.appendChild(priorityBadge);

  // Category badge
  if (task.category && task.category !== "Other") {
    const catBadge = document.createElement("span");
    catBadge.className = "badge badge-category";
    catBadge.textContent = task.category;
    meta.appendChild(catBadge);
  }

  // Due date badge
  if (task.dueDate) {
    const dueBadge = document.createElement("span");
    const isOverdue = isTaskOverdue(task.dueDate) && task.status !== "done";
    dueBadge.className = `badge ${isOverdue ? "badge-due-overdue" : "badge-due"}`;
    dueBadge.textContent = `📅 ${formatDate(task.dueDate)}${isOverdue ? " ⚠" : ""}`;
    dueBadge.setAttribute("aria-label", `Due: ${task.dueDate}${isOverdue ? " (overdue)" : ""}`);
    meta.appendChild(dueBadge);
  }

  card.appendChild(meta);

  // ── Drag events ──
  card.addEventListener("dragstart", (e) => handleDragStart(e, task.id));
  card.addEventListener("dragend",   handleDragEnd);

  // ── Keyboard: Enter/Space opens edit, Delete key triggers delete ──
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openEditModal(task.id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      openDeleteModal(task.id);
    }
  });

  return card;
}

/**
 * Update the task-count badge in each column header.
 */
function updateCounts() {
  const statuses = ["todo", "progress", "done"];
  const q = searchQuery.toLowerCase().trim();

  statuses.forEach((status) => {
    let count = Array.from(taskStore.values()).filter((t) => t.status === status).length;
    if (q) {
      count = Array.from(taskStore.values()).filter(
        (t) =>
          t.status === status &&
          (t.title.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            (t.category || "").toLowerCase().includes(q))
      ).length;
    }
    const badge = document.getElementById(`count-${status}`);
    if (badge) badge.textContent = count;
  });
}

/* ============================================================
   10. MODAL HELPERS
============================================================ */

/**
 * Open the Add / Edit task modal.
 * @param {'todo'|'progress'|'done'} status - Pre-selected column status
 */
function openAddModal(status = "todo") {
  const modal     = document.getElementById("task-modal");
  const titleEl   = document.getElementById("modal-title");
  const submitBtn = document.getElementById("task-submit-btn");
  const form      = document.getElementById("task-form");

  // Reset form
  form.reset();
  document.getElementById("task-id").value     = "";
  document.getElementById("task-status").value = status;
  document.getElementById("task-form-error").textContent = "";

  titleEl.textContent   = "Add Task";
  submitBtn.textContent = "Add Task";

  modal.classList.remove("hidden");
  document.getElementById("task-title").focus();
}

/**
 * Open the modal pre-populated with an existing task's data (edit mode).
 * @param {string} taskId
 */
function openEditModal(taskId) {
  const task = taskStore.get(taskId);
  if (!task) return;

  const modal     = document.getElementById("task-modal");
  const titleEl   = document.getElementById("modal-title");
  const submitBtn = document.getElementById("task-submit-btn");

  document.getElementById("task-id").value          = task.id;
  document.getElementById("task-status").value      = task.status;
  document.getElementById("task-title").value        = task.title;
  document.getElementById("task-description").value = task.description || "";
  document.getElementById("task-priority").value     = task.priority   || "medium";
  document.getElementById("task-category").value     = task.category   || "Other";
  document.getElementById("task-due").value          = task.dueDate    || "";
  document.getElementById("task-form-error").textContent = "";

  titleEl.textContent   = "Edit Task";
  submitBtn.textContent = "Save Changes";

  modal.classList.remove("hidden");
  document.getElementById("task-title").focus();
}

/** Close the task modal. */
function closeTaskModal() {
  document.getElementById("task-modal").classList.add("hidden");
}

/**
 * Open the delete confirmation modal.
 * @param {string} taskId
 */
function openDeleteModal(taskId) {
  pendingDeleteId = taskId;
  document.getElementById("delete-modal").classList.remove("hidden");
  document.getElementById("delete-confirm-btn").focus();
}

/** Close the delete confirmation modal. */
function closeDeleteModal() {
  pendingDeleteId = null;
  document.getElementById("delete-modal").classList.add("hidden");
}

/* ============================================================
   11. TOAST NOTIFICATIONS
============================================================ */
let toastTimer = null;

/**
 * Show a brief toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warn'|''} [type='']
 * @param {number} [duration=2800] - ms to show toast
 */
function showToast(message, type = "", duration = 2800) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className   = `toast${type ? ` toast-${type}` : ""}`;
  toast.classList.remove("hidden");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, duration);
}

/* ============================================================
   12. AUTH SCREEN UI
============================================================ */

/** Switch to showing the auth screen, hiding the main app. */
function showAuthScreen() {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

/** Switch to showing the main app, hiding the auth screen. */
function showApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

/* ============================================================
   13. EXAMPLE / SEED DATA
============================================================ */
/**
 * Seed the task store with example tasks if it is empty.
 * This helps first-time visitors understand what the board does.
 */
function seedExampleTasks() {
  if (taskStore.size > 0) return;

  const examples = [
    {
      title:       "Set up project structure",
      description: "Create folders, files, and initial configuration.",
      status:      "done",
      priority:    "high",
      category:    "Work",
      dueDate:     "",
    },
    {
      title:       "Design wireframes",
      description: "Sketch UI layout for all main screens.",
      status:      "done",
      priority:    "medium",
      category:    "Work",
      dueDate:     "",
    },
    {
      title:       "Build Kanban board UI",
      description: "Three columns, drag-and-drop, task cards.",
      status:      "progress",
      priority:    "high",
      category:    "Work",
      dueDate:     "",
    },
    {
      title:       "Write unit tests",
      description: "Cover CRUD operations and drag logic.",
      status:      "todo",
      priority:    "medium",
      category:    "Work",
      dueDate:     "",
    },
    {
      title:       "Deploy to production",
      description: "Push to hosting and verify all features.",
      status:      "todo",
      priority:    "low",
      category:    "Work",
      dueDate:     "",
    },
  ];

  examples.forEach((fields) => {
    const id = generateId();
    taskStore.set(id, { id, createdAt: Date.now() - Math.random() * 1e7, ...fields });
  });

  saveTasks();
}

/* ============================================================
   14. UTILITY HELPERS
============================================================ */

/**
 * Format an ISO date string (yyyy-mm-dd) to a human-friendly string.
 * @param {string} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Check whether a task's due date has passed today.
 * @param {string} dateStr
 * @returns {boolean}
 */
function isTaskOverdue(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + "T00:00:00");
  return due < today;
}

/**
 * Sanitise user-supplied text to prevent XSS when inserting into the DOM.
 * (We use textContent rather than innerHTML for card content, but this is
 * kept here as a belt-and-braces guard for any future innerHTML usage.)
 * @param {string} str
 * @returns {string}
 */
function sanitise(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================
   15. EVENT WIRING
============================================================ */
function wireEvents() {

  // ── Auth tabs ──────────────────────────────────────────────
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const target = tab.dataset.tab;
      document.getElementById("panel-login").classList.toggle(
        "hidden", target !== "login"
      );
      document.getElementById("panel-signup").classList.toggle(
        "hidden", target !== "signup"
      );
    });
  });

  // ── Login form ─────────────────────────────────────────────
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl  = document.getElementById("login-error");
    errorEl.textContent = "";

    if (!email || !password) {
      errorEl.textContent = "Please enter email and password.";
      return;
    }

    const btn = document.getElementById("login-btn");
    btn.disabled   = true;
    btn.textContent = "Logging in…";

    try {
      await login(email, password);
      // onAuthStateChanged will handle the rest
    } catch (err) {
      errorEl.textContent = friendlyAuthError(err.code);
    } finally {
      btn.disabled   = false;
      btn.textContent = "Login";
    }
  });

  // ── Sign-up form ───────────────────────────────────────────
  document.getElementById("signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name     = document.getElementById("signup-name").value.trim();
    const email    = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const errorEl  = document.getElementById("signup-error");
    errorEl.textContent = "";

    if (!name || !email || !password) {
      errorEl.textContent = "All fields are required.";
      return;
    }
    if (password.length < 6) {
      errorEl.textContent = "Password must be at least 6 characters.";
      return;
    }

    const btn = document.getElementById("signup-btn");
    btn.disabled   = true;
    btn.textContent = "Creating account…";

    try {
      await signUp(email, password, name);
      // onAuthStateChanged will handle the rest
    } catch (err) {
      errorEl.textContent = friendlyAuthError(err.code);
    } finally {
      btn.disabled   = false;
      btn.textContent = "Create Account";
    }
  });

  // ── Guest mode ─────────────────────────────────────────────
  document.getElementById("guest-btn").addEventListener("click", () => {
    currentUserId = null;
    document.getElementById("user-display").textContent = "Guest";

    // Load from localStorage (may already have tasks from a prior session)
    const stored = loadTasksFromLocalStorage();
    taskStore.clear();
    stored.forEach((t) => taskStore.set(t.id, t));

    // Seed examples if storage is empty
    seedExampleTasks();

    showApp();
    renderTasks();
  });

  // ── Logout ─────────────────────────────────────────────────
  document.getElementById("logout-btn").addEventListener("click", () => logout());

  // ── Add Task buttons (one per column) ─────────────────────
  document.querySelectorAll(".btn-add-task").forEach((btn) => {
    btn.addEventListener("click", () => openAddModal(btn.dataset.status));
  });

  // ── Task form submission (add or edit) ────────────────────
  document.getElementById("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    const title     = document.getElementById("task-title").value.trim();
    const errorEl   = document.getElementById("task-form-error");
    errorEl.textContent = "";

    if (!title) {
      errorEl.textContent = "Title is required.";
      document.getElementById("task-title").focus();
      return;
    }

    const taskId      = document.getElementById("task-id").value;
    const status      = document.getElementById("task-status").value;
    const description = document.getElementById("task-description").value.trim();
    const priority    = document.getElementById("task-priority").value;
    const category    = document.getElementById("task-category").value;
    const dueDate     = document.getElementById("task-due").value;

    closeTaskModal();

    if (taskId) {
      // Edit existing task
      await editTask(taskId, { title, description, status, priority, category, dueDate });
    } else {
      // Add new task
      await addTask({ title, description, status, priority, category, dueDate });
    }
  });

  // ── Modal close buttons ────────────────────────────────────
  document.getElementById("modal-close-btn").addEventListener("click",  closeTaskModal);
  document.getElementById("modal-cancel-btn").addEventListener("click", closeTaskModal);

  // Close modal when clicking the backdrop
  document.getElementById("task-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeTaskModal();
  });

  // ── Delete modal ───────────────────────────────────────────
  document.getElementById("delete-modal-close").addEventListener("click", closeDeleteModal);
  document.getElementById("delete-cancel-btn").addEventListener("click", closeDeleteModal);
  document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
    if (pendingDeleteId) {
      await deleteTask(pendingDeleteId);
      closeDeleteModal();
    }
  });
  document.getElementById("delete-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });

  // ── Column drag-and-drop events ────────────────────────────
  document.querySelectorAll(".column").forEach((col) => {
    col.addEventListener("dragover",   (e) => handleDragOver(e, col));
    col.addEventListener("dragleave",  () => handleDragLeave(col));
    col.addEventListener("drop",       (e) => handleDrop(e, col));
  });

  // ── Search ─────────────────────────────────────────────────
  document.getElementById("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderTasks();
  });

  // ── Keyboard: Escape closes any open modal ─────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!document.getElementById("task-modal").classList.contains("hidden")) {
        closeTaskModal();
      }
      if (!document.getElementById("delete-modal").classList.contains("hidden")) {
        closeDeleteModal();
      }
    }
  });
}

/* ============================================================
   16. FRIENDLY AUTH ERROR MESSAGES
============================================================ */
/**
 * Map Firebase Auth error codes to human-readable messages.
 * @param {string} code - Firebase error code, e.g. "auth/wrong-password"
 * @returns {string}
 */
function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found":      "No account found with that email.",
    "auth/wrong-password":      "Incorrect password. Please try again.",
    "auth/invalid-email":       "Please enter a valid email address.",
    "auth/email-already-in-use":"An account with this email already exists.",
    "auth/weak-password":       "Password must be at least 6 characters.",
    "auth/too-many-requests":   "Too many attempts — please try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/invalid-credential":  "Invalid email or password.",
  };
  return map[code] || "An error occurred. Please try again.";
}

/* ============================================================
   17. BOOT
============================================================ */
/**
 * Application entry point.
 * Initialises Firebase, wires events, and decides whether to show
 * the auth screen or load directly (returning user session).
 */
function boot() {
  // 1. Try to initialise Firebase
  initFirebase();

  // 2. Wire all DOM events
  wireEvents();

  // 3. Set up Firebase auth listener (no-op if not configured)
  if (firebaseEnabled) {
    onAuthChange();
    // onAuthStateChanged will call showApp() or showAuthScreen() asynchronously
  } else {
    // Firebase not configured — show auth screen so guest can enter
    // (a previous guest session will be restored on guest-btn click)
    showAuthScreen();
  }
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

/* ============================================================
   FIRESTORE SECURITY RULES
   Copy into Firebase Console → Firestore → Rules tab.

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/tasks/{taskId} {
         allow read, write: if request.auth != null
                            && request.auth.uid == userId;
       }
     }
   }
============================================================ */
