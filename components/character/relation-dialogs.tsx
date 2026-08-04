"use client";

// 画布拉线的两个纸片风弹窗：
// RelationLinkDialog —— 点照片A→照片B后输入关系标签
// RelationPairSheet —— 点线上标签，逐条查看/删除两人之间的关系

import { useState } from "react";
import type { CharacterWorldRelation } from "@/lib/character-world-storage";

export function RelationLinkDialog({
  fromName,
  toName,
  onConfirm,
  onCancel,
}: {
  fromName: string;
  toName: string;
  onConfirm: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const submit = () => {
    if (!label.trim()) return;
    onConfirm(label.trim());
  };
  return (
    <div className="wt-modal" onClick={onCancel}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">RED STRING</div>
        <div className="wt-relation-row">
          <strong>{fromName}</strong>
          <span className="wt-relation-dash">is</span>
          <strong>{toName}</strong>
          <span className="wt-relation-dash">'s...</span>
        </div>
        <input
          className="wt-paper-input"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. brother / rival / boss"
        />
        <div className="wt-paper-actions">
          <button type="button" className="wt-btn" onClick={onCancel}>Cancel</button>
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" disabled={!label.trim()} onClick={submit}>Link</button>
        </div>
      </div>
    </div>
  );
}

export function RelationPairSheet({
  relations,
  nameById,
  onDelete,
  onClose,
}: {
  /** 这对角色之间的全部关系（两个方向都算） */
  relations: CharacterWorldRelation[];
  nameById: Map<string, string>;
  onDelete: (relationId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-tape" aria-hidden />
        <div className="wt-paper-kicker">RELATIONS</div>
        {relations.length === 0 ? (
          <p className="wt-paper-hint">There are no more relations between these two.</p>
        ) : (
          <ul className="wt-relation-list">
            {relations.map(relation => (
              <li key={relation.id} className="wt-relation-item">
                <span className="wt-relation-text">
                  {nameById.get(relation.fromCharacterId) ?? "?"} is{" "}
                  {nameById.get(relation.toCharacterId) ?? "?"}'s{" "}
                  "{relation.label}"
                </span>
                <button
                  type="button"
                  className="wt-btn wt-btn-danger wt-btn-small"
                  onClick={() => onDelete(relation.id)}
                  aria-label="Delete this relation"
                >
                  Cut
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="wt-paper-actions">
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
