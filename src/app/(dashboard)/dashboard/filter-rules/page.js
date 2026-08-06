"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function normalizeFormData(data = {}) {
  return {
    ruleId: data.ruleId || "",
    pattern: data.pattern || "",
    replacement: data.replacement ?? "",
    isActive: data.isActive !== false,
    isRegex: data.isRegex === true,
  };
}

function SortableRule({ rule, onToggle, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: rule.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between ${isDragging ? "shadow-md ring-1 ring-primary/30 rounded-lg" : ""}`}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="mt-0.5 cursor-grab touch-none p-1 text-text-muted hover:text-text-main"
          title="Drag to reorder"
        >
          <span className="material-symbols-outlined text-[18px]">drag_indicator</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="min-w-0 max-w-full truncate text-sm font-medium">{rule.ruleId}</code>
            <Badge variant={rule.isRegex ? "default" : "default"} size="sm">
              {rule.isRegex ? "regex" : "string"}
            </Badge>
            <Badge variant={rule.isActive ? "success" : "default"} size="sm">
              {rule.isActive ? "active" : "off"}
            </Badge>
          </div>
          <p className="text-xs text-text-muted truncate mt-1 font-mono" title={rule.pattern}>
            {rule.pattern}
          </p>
          {rule.replacement ? (
            <p className="text-[11px] text-text-muted truncate">→ {rule.replacement}</p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1">
        <Toggle
          size="sm"
          checked={rule.isActive === true}
          onChange={() => onToggle(rule)}
          title={rule.isActive ? "Disable" : "Enable"}
        />
        <button
          onClick={() => onEdit(rule)}
          className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
          title="Edit"
        >
          <span className="material-symbols-outlined text-[18px]">edit</span>
        </button>
        <button
          onClick={() => onDelete(rule)}
          className="p-2 rounded hover:bg-red-500/10 text-red-500"
          title="Delete"
        >
          <span className="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    </div>
  );
}

export default function FilterRulesPage() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [formData, setFormData] = useState(normalizeFormData());
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sampleText, setSampleText] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const notify = useNotificationStore();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/filter-rules", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setRules(data.rules || []);
      }
    } catch (error) {
      console.log("Error fetching filter rules:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMaster = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setMasterEnabled(!!data.filterRulesEnabled);
    } catch (error) {
      console.log("Error fetching settings:", error);
    }
  }, []);

  useEffect(() => {
    load();
    loadMaster();
  }, [load, loadMaster]);

  // Real-time: refresh when another tab mutates rules.
  useEffect(() => {
    let es;
    try {
      es = new EventSource("/api/filter-rules/stream");
      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === "filter_rules_updated") {
            load();
            loadMaster();
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => { /* EventSource auto-reconnects */ };
    } catch { /* ignore */ }
    return () => { try { es?.close(); } catch {} };
  }, [load, loadMaster]);

  const activeCount = useMemo(() => rules.filter((r) => r.isActive).length, [rules]);

  const resetForm = () => {
    setEditingRule(null);
    setFormData(normalizeFormData());
    setPreview(null);
    setSampleText("");
  };

  const openCreateModal = () => {
    resetForm();
    setShowFormModal(true);
  };

  const openEditModal = (rule) => {
    setEditingRule(rule);
    setFormData(normalizeFormData(rule));
    setSampleText("");
    setPreview(null);
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    if (saving) return;
    setShowFormModal(false);
    resetForm();
  };

  const handleSave = async () => {
    const payload = {
      ruleId: formData.ruleId.trim(),
      pattern: formData.pattern,
      replacement: formData.replacement,
      isActive: formData.isActive === true,
      isRegex: formData.isRegex === true,
    };
    if (!payload.pattern) return;

    setSaving(true);
    try {
      const isEdit = !!editingRule;
      const res = await fetch(isEdit ? `/api/filter-rules/${editingRule.id}` : "/api/filter-rules", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await load();
        closeFormModal();
        notify.success(editingRule ? "Filter rule updated" : "Filter rule created");
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to save filter rule");
      }
    } catch (error) {
      console.log("Error saving filter rule:", error);
      notify.error("Failed to save filter rule");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (rule) => {
    setConfirmState({
      title: "Delete Filter Rule",
      message: `Delete rule "${rule.ruleId}"?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/filter-rules/${rule.id}`, { method: "DELETE" });
          if (res.ok) {
            setRules((prev) => prev.filter((r) => r.id !== rule.id));
            notify.success("Filter rule deleted");
          } else {
            const data = await res.json();
            notify.error(data.error || "Failed to delete filter rule");
          }
        } catch (error) {
          console.log("Error deleting filter rule:", error);
          notify.error("Failed to delete filter rule");
        }
      },
    });
  };

  const handleToggleActive = async (rule) => {
    const next = !rule.isActive;
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: next } : r)));
    try {
      const res = await fetch(`/api/filter-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: rule.isActive } : r)));
        notify.error("Failed to update active state");
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: rule.isActive } : r)));
      notify.error("Failed to update active state");
    }
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = rules.findIndex((r) => r.id === active.id);
    const newIndex = rules.findIndex((r) => r.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(rules, oldIndex, newIndex);
    setRules(next);
    try {
      await fetch("/api/filter-rules/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next.map((r) => r.id) }),
      });
    } catch (error) {
      console.log("Error reordering:", error);
      await load(); // rollback on failure
    }
  };

  const handleMasterToggle = async (next) => {
    const prev = masterEnabled;
    setMasterEnabled(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filterRulesEnabled: next }),
      });
      if (!res.ok) {
        setMasterEnabled(prev);
        notify.error("Failed to update master toggle");
      } else {
        notify.success(next ? "Filter rules enabled" : "Filter rules disabled");
      }
    } catch (error) {
      console.log("Error toggling master:", error);
      setMasterEnabled(prev);
      notify.error("Failed to update master toggle");
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch("/api/filter-rules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: formData.pattern,
          replacement: formData.replacement,
          isRegex: formData.isRegex === true,
          sample: sampleText,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPreview(data);
      } else {
        notify.error(data.error || "Preview failed");
      }
    } catch (error) {
      console.log("Error previewing:", error);
      notify.error("Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Filter Rules</h1>
          <p className="text-sm text-text-muted mt-1">
            Sanitize request content before it reaches the upstream provider.
          </p>
        </div>
        <Button size="sm" icon="add" onClick={openCreateModal}>Add Rule</Button>
      </div>

      {/* Master toggle */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-sm">Master Switch</p>
            <p className="text-xs text-text-muted">
              When off, no filter rules are applied to outgoing requests. Applies to both dashboard and MITM paths.
            </p>
          </div>
          <Toggle
            checked={masterEnabled}
            onChange={() => handleMasterToggle(!masterEnabled)}
          />
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge variant="default">Total: {rules.length}</Badge>
          <Badge variant="success">Active: {activeCount}</Badge>
          {!masterEnabled && <Badge variant="default">master off</Badge>}
        </div>

        {rules.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-text-main font-medium mb-1">No filter rules yet</p>
            <p className="text-sm text-text-muted mb-4">
              Add a rule to strip or replace patterns in request content.
            </p>
            <Button icon="add" onClick={openCreateModal}>Add Rule</Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {rules.map((rule) => (
                  <SortableRule
                    key={rule.id}
                    rule={rule}
                    onToggle={handleToggleActive}
                    onEdit={openEditModal}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      <Modal
        isOpen={showFormModal}
        title={editingRule ? "Edit Filter Rule" : "Add Filter Rule"}
        onClose={closeFormModal}
        size="md"
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Rule ID (optional)"
            value={formData.ruleId}
            onChange={(e) => setFormData((prev) => ({ ...prev, ruleId: e.target.value }))}
            placeholder="remove_cc_version"
            hint="Human-readable name. Auto-generated if left empty."
          />
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Pattern</label>
            <textarea
              value={formData.pattern}
              onChange={(e) => setFormData((prev) => ({ ...prev, pattern: e.target.value }))}
              placeholder={formData.isRegex ? "<identity>.*?</identity>" : "exact string to remove"}
              className="w-full min-h-[80px] py-2 px-3 text-sm font-mono text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Replacement</label>
            <textarea
              value={formData.replacement}
              onChange={(e) => setFormData((prev) => ({ ...prev, replacement: e.target.value }))}
              placeholder="Leave empty to remove the pattern"
              className="w-full min-h-[60px] py-2 px-3 text-sm font-mono text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Regex mode</p>
              <p className="text-xs text-text-muted">Treat pattern as a regular expression (case-insensitive, global).</p>
            </div>
            <Toggle
              checked={formData.isRegex === true}
              onChange={() => setFormData((prev) => ({ ...prev, isRegex: !prev.isRegex }))}
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Active</p>
              <p className="text-xs text-text-muted">Inactive rules are skipped by the sanitizer.</p>
            </div>
            <Toggle
              checked={formData.isActive === true}
              onChange={() => setFormData((prev) => ({ ...prev, isActive: !prev.isActive }))}
              disabled={saving}
            />
          </div>

          {/* Preview / test */}
          <div className="rounded-lg border border-border/50 p-3">
            <p className="font-medium text-sm mb-2">Test pattern</p>
            <textarea
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              placeholder="Paste sample text to test the pattern against…"
              className="w-full min-h-[70px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="science"
                onClick={handlePreview}
                disabled={!formData.pattern || previewing}
              >
                {previewing ? "Testing…" : "Test"}
              </Button>
              {preview && (
                <span className="text-xs">
                  {preview.error ? (
                    <span className="text-red-500">Error: {preview.error}</span>
                  ) : preview.matched ? (
                    <Badge variant="success" size="sm">matched</Badge>
                  ) : (
                    <Badge variant="default" size="sm">no match</Badge>
                  )}
                </span>
              )}
            </div>
            {preview && !preview.error && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 text-xs text-text-main">
                {preview.result}
              </pre>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth onClick={handleSave} disabled={!formData.pattern || saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeFormModal} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
