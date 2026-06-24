// diffViewer.js — Recast Diff Viewer
// Word-level diff rendering and review modal management.
// sponsored by claude the goat

/// Helpers

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Split text into tokens: Chinese characters individually, English words as units, preserving whitespace
function tokenize(text) {
    return text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]|[a-zA-Z0-9]+|[^\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaffa-zA-Z0-9]+|\s+/g) || [];
}

// Split text into sentences (supports Chinese and English punctuation)
function tokenizeSentences(text) {
    // Match sentence-ending punctuation, keep it attached to the sentence
    return text.match(/[^。！？；.!?;]+[。！？；.!?;]?/g) || [text];
}

// Word-level diff for a single sentence pair, returns { oldHtml, newHtml }
function computeWordDiffForSentence(oldSent, newSent) {
    const a = tokenize(oldSent);
    const b = tokenize(newSent);

    // Common prefix
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;

    // Common suffix
    let endA = a.length - 1, endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

    const subA = a.slice(start, endA + 1);
    const subB = b.slice(start, endB + 1);

    let ops = myersDiff(subA, subB);
    if (!ops) {
        ops = [...subA.map(v => ({ type: "delete", v })), ...subB.map(v => ({ type: "insert", v }))];
    }

    const fullOps = [
        ...a.slice(0, start).map(v => ({ type: "equal", v })),
        ...ops,
        ...a.slice(endA + 1).map(v => ({ type: "equal", v }))
    ];

    let oldHtml = "", newHtml = "";
    for (const op of fullOps) {
        if (op.v === undefined || op.v === null) continue;
        const v = escapeHtml(op.v);
        if (op.type === "equal")        { oldHtml += v; newHtml += v; }
        else if (op.type === "delete")  { oldHtml += `<del class="rc-del">${v}</del>`; }
        else                            { newHtml += `<ins class="rc-ins">${v}</ins>`; }
    }
    return { oldHtml, newHtml };
}

//

const MAX_DIFF_TOKENS = 50000;

function myersDiff(oldTokens, newTokens) {
    const oldLength = oldTokens.length;
    const newLength = newTokens.length;
    const maxTotalLength = oldLength + newLength;
    const furthestPaths = new Int32Array(2 * maxTotalLength + 1);
    const pathHistory = [];

    furthestPaths[maxTotalLength + 1] = 0;

    for (let editDepth = 0; editDepth <= maxTotalLength; editDepth++) {
        // Memory safeguard for highly divergent huge texts (keeps memory < 100MB)
        if (editDepth > 10000) return null;
        
        pathHistory.push(furthestPaths.slice(maxTotalLength - editDepth, maxTotalLength + editDepth + 1));

        for (let diagonal = -editDepth; diagonal <= editDepth; diagonal += 2) {
            let oldPos;
            const goDown = (diagonal === -editDepth || (diagonal !== editDepth && furthestPaths[maxTotalLength + diagonal - 1] < furthestPaths[maxTotalLength + diagonal + 1]));

            if (goDown) {
                oldPos = furthestPaths[maxTotalLength + diagonal + 1];
            } else {
                oldPos = furthestPaths[maxTotalLength + diagonal - 1] + 1;
            }

            let newPos = oldPos - diagonal;

            while (oldPos < oldLength && newPos < newLength && oldTokens[oldPos] === newTokens[newPos]) {
                oldPos++;
                newPos++;
            }

            furthestPaths[maxTotalLength + diagonal] = oldPos;

            if (oldPos >= oldLength && newPos >= newLength) {
                const ops = [];
                let currOldPos = oldLength, currNewPos = newLength;

                for (let step = editDepth; step > 0; step--) {
                    const historyArray = pathHistory[step];
                    const currDiagonal = currOldPos - currNewPos;
                    const histIndex = step + currDiagonal;

                    const wentDown = (currDiagonal === -step || (currDiagonal !== step && historyArray[histIndex - 1] < historyArray[histIndex + 1]));

                    let startX, startY;
                    if (wentDown) {
                        startX = historyArray[histIndex + 1];
                    } else {
                        startX = historyArray[histIndex - 1] + 1;
                    }
                    startY = startX - currDiagonal;

                    while (currOldPos > startX && currNewPos > startY && currOldPos > 0 && currNewPos > 0) {
                        ops.unshift({ type: "equal", v: oldTokens[currOldPos - 1] });
                        currOldPos--; currNewPos--;
                    }

                    if (wentDown) {
                        if (currNewPos > 0) {
                            ops.unshift({ type: "insert", v: newTokens[currNewPos - 1] });
                            currNewPos--;
                        }
                    } else {
                        if (currOldPos > 0) {
                            ops.unshift({ type: "delete", v: oldTokens[currOldPos - 1] });
                            currOldPos--;
                        }
                    }
                }
                while (currOldPos > 0 && currNewPos > 0) {
                    ops.unshift({ type: "equal", v: oldTokens[currOldPos - 1] });
                    currOldPos--; currNewPos--;
                }
                while (currOldPos > 0) {
                    ops.unshift({ type: "delete", v: oldTokens[currOldPos - 1] });
                    currOldPos--;
                }
                while (currNewPos > 0) {
                    ops.unshift({ type: "insert", v: newTokens[currNewPos - 1] });
                    currNewPos--;
                }
                return ops;
            }
        }
    }
    return [];
}

function computeWordDiff(oldText, newText) {
    const oldSentences = tokenizeSentences(oldText);
    const newSentences = tokenizeSentences(newText);

    // Sentence-level diff
    let sentenceOps = myersDiff(oldSentences, newSentences);
    if (!sentenceOps) {
        sentenceOps = [
            ...oldSentences.map(v => ({ type: "delete", v })),
            ...newSentences.map(v => ({ type: "insert", v }))
        ];
    }

    // Group consecutive delete/insert ops into blocks, then pair them for word-level diff
    let oldHtml = "", newHtml = "";
    let i = 0;
    while (i < sentenceOps.length) {
        const op = sentenceOps[i];

        if (op.type === "equal") {
            const v = escapeHtml(op.v);
            oldHtml += v;
            newHtml += v;
            i++;
        } else if (op.type === "delete") {
            // Collect consecutive deletes
            const deletes = [];
            while (i < sentenceOps.length && sentenceOps[i].type === "delete") {
                deletes.push(sentenceOps[i].v);
                i++;
            }
            // Collect consecutive inserts
            const inserts = [];
            while (i < sentenceOps.length && sentenceOps[i].type === "insert") {
                inserts.push(sentenceOps[i].v);
                i++;
            }
            // Pair deletes and inserts for word-level diff
            const pairCount = Math.min(deletes.length, inserts.length);
            for (let p = 0; p < pairCount; p++) {
                const result = computeWordDiffForSentence(deletes[p], inserts[p]);
                oldHtml += result.oldHtml;
                newHtml += result.newHtml;
            }
            // Unpaired deletes
            for (let d = pairCount; d < deletes.length; d++) {
                oldHtml += `<del class="rc-del">${escapeHtml(deletes[d])}</del>`;
            }
            // Unpaired inserts
            for (let p = pairCount; p < inserts.length; p++) {
                newHtml += `<ins class="rc-ins">${escapeHtml(inserts[p])}</ins>`;
            }
        } else if (op.type === "insert") {
            newHtml += `<ins class="rc-ins">${escapeHtml(op.v)}</ins>`;
            i++;
        } else {
            i++;
        }
    }

    // Fallback: if sentence tokenizer produced no visible diff but texts differ
    if (oldHtml === "" && newHtml === "" && oldText !== newText) {
        return computeWordDiffDirect(oldText, newText);
    }

    return { oldHtml, newHtml };
}

// Direct word-level diff (original logic for fallback)
function computeWordDiffDirect(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);

    if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
        return { oldHtml: escapeHtml(oldText), newHtml: escapeHtml(newText) };
    }

    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;

    let endA = a.length - 1, endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

    const subA = a.slice(start, endA + 1);
    const subB = b.slice(start, endB + 1);

    let ops = myersDiff(subA, subB);
    if (!ops) {
        ops = [...subA.map(v => ({ type: "delete", v })), ...subB.map(v => ({ type: "insert", v }))];
    }

    const fullOps = [
        ...a.slice(0, start).map(v => ({ type: "equal", v })),
        ...ops,
        ...a.slice(endA + 1).map(v => ({ type: "equal", v }))
    ];

    let oldHtml = "", newHtml = "";
    for (const op of fullOps) {
        if (op.v === undefined || op.v === null) continue;
        const v = escapeHtml(op.v);
        if (op.type === "equal")        { oldHtml += v; newHtml += v; }
        else if (op.type === "delete")  { oldHtml += `<del class="rc-del">${v}</del>`; }
        else                            { newHtml += `<ins class="rc-ins">${v}</ins>`; }
    }
    return { oldHtml, newHtml };
}

//

let _acceptCallback = null;
let _rejectCallback = null;

// Step navigation state
let _steps = null;
let _currentStep = 0;
let _stepEdits = {}; // Track edits per step: { stepIndex: editedText }

import { extension_settings } from "../../../../extensions.js";

//

// Build comparison steps from pass snapshots.
// snapshots: [originalText, afterPass1, afterPass2, ..., finalText]
// passNames: ["Pass1Name", "Pass2Name", ...] — names of enabled passes in order
function buildSteps(snapshots, passNames) {
    if (!snapshots || snapshots.length < 2) return null;

    const getPassName = (i) => (passNames && passNames[i - 1]) ? passNames[i - 1] : null;

    const steps = [];

    // Step 0: full diff — original vs final (current default view)
    steps.push({
        oldText: snapshots[0],
        newText: snapshots[snapshots.length - 1],
        oldLabel: "Original",
        newLabel: "Final"
    });

    // Steps 1..N: incremental diffs between consecutive passes
    for (let i = 0; i < snapshots.length - 1; i++) {
        steps.push({
            oldText: snapshots[i],
            newText: snapshots[i + 1],
            oldLabel: i === 0 ? "Original" : `Pass ${i}`,
            newLabel: `Pass ${i + 1}`,
            caption: i === 0 ? "Original → Pass 1" : `Pass ${i} → Pass ${i + 1}`,
            passName: getPassName(i + 1)
        });
    }

    return steps;
}

function getStepCaption(stepIndex) {
    if (stepIndex === 0) return "Full Diff";
    if (!_steps || !_steps[stepIndex]) return `Step ${stepIndex}`;
    return _steps[stepIndex].caption || `Step ${stepIndex}`;
}

//

function renderStep(stepIndex) {
    if (!_steps || stepIndex < 0 || stepIndex >= _steps.length) return;
    _currentStep = stepIndex;

    const step = _steps[stepIndex];
    const lastStepIndex = _steps.length - 1;

    // Resolve oldText: if previous step was edited, use that edit as the base
    let oldText = step.oldText;
    if (stepIndex > 1 && _stepEdits[stepIndex - 1] !== undefined) {
        oldText = _stepEdits[stepIndex - 1];
    }

    // Resolve newText: use step edit if available
    let newText = step.newText;
    if (_stepEdits[stepIndex] !== undefined) {
        newText = _stepEdits[stepIndex];
    }

    const { oldHtml, newHtml } = computeWordDiff(oldText, newText);

    // Update panel content
    $("#recast_diff_original_view").html(oldHtml);
    $("#recast_diff_transformed_view").html(newHtml);

    // Update panel header labels
    $(".rc-diff-original-header .rc-diff-panel-label").text(step.oldLabel);
    $(".rc-diff-transformed-header .rc-diff-panel-label").text(step.newLabel);

    // Update active dot
    $(".rc-diff-dot").removeClass("rc-diff-dot-active");
    $(`.rc-diff-dot[data-step="${stepIndex}"]`).addClass("rc-diff-dot-active");

    // Update step caption text — append pass name annotation when available
    const caption = getStepCaption(stepIndex);
    const passName = stepIndex > 0 && step.passName ? step.passName : null;
    if (passName) {
        $("#recast_diff_step_label").html(`${caption} <span class="rc-diff-step-name">(${escapeHtml(passName)})</span>`);
    } else {
        $("#recast_diff_step_label").text(caption);
    }

    // Update arrow disabled state
    $("#recast_diff_prev").prop("disabled", stepIndex === 0);
    $("#recast_diff_next").prop("disabled", stepIndex === _steps.length - 1);
}

function renderNavigation() {
    const stepsBar = $("#recast_diff_steps");
    const dotsContainer = $("#recast_diff_dots");
    dotsContainer.empty();

    // Navigation only makes sense with 3+ steps (i.e., 2+ passes producing distinct diffs)
    if (!_steps || _steps.length < 3) {
        stepsBar.hide();
        return;
    }

    for (let i = 0; i < _steps.length; i++) {
        dotsContainer.append(
            $(`<button class="rc-diff-dot" data-step="${i}" title="${getStepCaption(i)}"></button>`)
        );
    }

    stepsBar.show();
}

// Get the current text for the active step (with any edits applied)
function getCurrentStepText() {
    if (_steps && _currentStep >= 0 && _currentStep < _steps.length) {
        if (_stepEdits[_currentStep] !== undefined) {
            return _stepEdits[_currentStep];
        }
        return _steps[_currentStep].newText;
    }
    return $("#recast_diff_transformed_view").text();
}

// Edit modal functions
function openEditModal() {
    const currentText = getCurrentStepText();
    $("#recast_edit_textarea").val(currentText);
    $("#recast_edit_backdrop").fadeIn(150);
    $("#recast_edit_modal").fadeIn(180);
    $("#recast_edit_textarea").focus();
}

function closeEditModal() {
    $("#recast_edit_backdrop").fadeOut(120);
    $("#recast_edit_modal").fadeOut(150);
}

function saveEdit() {
    const newText = $("#recast_edit_textarea").val();
    _stepEdits[_currentStep] = newText;

    // Bidirectional sync: keep step 0 and last step in sync
    if (_steps) {
        const lastStepIndex = _steps.length - 1;
        if (_currentStep === 0 && lastStepIndex >= 0) {
            _stepEdits[lastStepIndex] = newText;
        } else if (_currentStep === lastStepIndex && lastStepIndex >= 0) {
            _stepEdits[0] = newText;
        }
    }

    // Re-render the current step with the new text
    if (_steps && _currentStep >= 0 && _currentStep < _steps.length) {
        const lastStepIndex = _steps.length - 1;

        // Resolve oldText: if previous step was edited, use that edit as the base
        let oldText = _steps[_currentStep].oldText;
        if (_currentStep > 1 && _stepEdits[_currentStep - 1] !== undefined) {
            oldText = _stepEdits[_currentStep - 1];
        }

        const { oldHtml, newHtml } = computeWordDiff(oldText, newText);
        $("#recast_diff_original_view").html(oldHtml);
        $("#recast_diff_transformed_view").html(newHtml);
    } else {
        // Single-view mode
        const rawOriginal = $("#recast_diff_modal").data("original") || "";
        const { oldHtml, newHtml } = computeWordDiff(rawOriginal, newText);
        $("#recast_diff_original_view").html(oldHtml);
        $("#recast_diff_transformed_view").html(newHtml);
    }

    closeEditModal();
}

//

export function showDiffModal(originalText, transformedText, onAccept, onReject = null, passSnapshots = null, passNames = null, savedStepEdits = null) {
    _acceptCallback = onAccept;
    _rejectCallback = onReject;
    _currentStep = 0;
    _stepEdits = savedStepEdits || {}; // Restore saved edits or start fresh

    // Build navigation steps when 2+ passes are present
    _steps = (passSnapshots && passSnapshots.length >= 3) ? buildSteps(passSnapshots, passNames) : null;

    // Store original text
    $("#recast_diff_modal").data("original", originalText);

    // Show/hide edit button based on setting
    const disableEditable = extension_settings["Recast"] && extension_settings["Recast"].disable_editable_diff;
    if (disableEditable) {
        $("#recast_diff_edit").hide();
    } else {
        $("#recast_diff_edit").show();
    }

    if (_steps) {
        renderNavigation();
        renderStep(0);
    } else {
        // Classic single-view mode
        const { oldHtml, newHtml } = computeWordDiff(originalText, transformedText);
        $("#recast_diff_original_view").html(oldHtml);
        $("#recast_diff_transformed_view").html(newHtml);

        // Reset panel labels to defaults
        $(".rc-diff-original-header .rc-diff-panel-label").text("Original");
        $(".rc-diff-transformed-header .rc-diff-panel-label").text("Transformed");

        $("#recast_diff_steps").hide();
    }

    $("#recast_diff_backdrop").fadeIn(200);
    $("#recast_diff_modal").fadeIn(220);
}

export function hideDiffModal(isReject = false) {
    if (isReject && typeof _rejectCallback === "function") {
        _rejectCallback();
    }
    _steps = null;
    _currentStep = 0;
    _stepEdits = {};
    $("#recast_diff_backdrop").fadeOut(180);
    $("#recast_diff_modal").fadeOut(200);
}

export function initDiffViewer() {
    // Accept button — use the text from the last rendered diff view
    $("#recast_diff_accept").on("click", () => {
        const text = getCurrentStepText();
        if (typeof _acceptCallback === "function") _acceptCallback(text);
        // Don't close modal here - let the callback handle it (e.g., warning dialog)
    });

    $("#recast_diff_reject").on("click", () => hideDiffModal(true));

    $("#recast_diff_close, #recast_diff_backdrop").on("click", () => hideDiffModal(false));

    // Edit button — open edit modal
    $("#recast_diff_edit").on("click", () => openEditModal());

    // Edit modal — save/cancel/close
    $("#recast_edit_save").on("click", () => saveEdit());
    $("#recast_edit_cancel, #recast_edit_close").on("click", () => closeEditModal());
    $("#recast_edit_backdrop").on("click", () => closeEditModal());

    // Step navigation — prev/next arrows
    $("#recast_diff_prev").on("click", () => {
        if (_steps && _currentStep > 0) renderStep(_currentStep - 1);
    });

    $("#recast_diff_next").on("click", () => {
        if (_steps && _currentStep < _steps.length - 1) renderStep(_currentStep + 1);
    });

    // Step navigation — dot clicks (delegated since dots are dynamic)
    $(document).on("click", "#recast_diff_dots .rc-diff-dot", function () {
        if (_steps) renderStep(parseInt($(this).data("step"), 10));
    });
}

// Export function to get current step edits
export function getStepEdits() {
    return { ..._stepEdits };
}
