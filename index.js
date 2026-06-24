// IMPORTS
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, generateRaw, updateMessageBlock, messageFormatting, scrollChatToBottom, setSendButtonState, isStreamingEnabled as isSTStreamingEnabled, showSwipeButtons} from "../../../../script.js";
import { power_user } from "../../../power-user.js"
import { applyStreamFadeIn } from "../../../util/stream-fadein.js";
import { getWorldInfoPrompt } from "../../../world-info.js";
import { MacrosParser } from "../../../macros.js";
import { getRegexedString, regex_placement } from "../../regex/engine.js";
// Settings
import { loadSettings, saveSettings, defaultSettings, initSettingsListeners } from "./settings/settingsManager.js";
export { loadSettings, saveSettings, defaultSettings };

// Self Util
import { showDiffModal, hideDiffModal, initDiffViewer, getStepEdits } from "./util/diffViewer.js";
import { swapProfile } from "./util/profileSwapper.js";
import { presetManager } from "./ui/presetManager.js";
// Compatibility Extensions
import { initCompatibilityListeners, shouldSkipStreamIntercept, shouldIgnoreMessageReceived } from "./util/compatibility.js";
// UI
import { pipelineBar } from "./ui/pipelineBar.js";
// Slash Commands
import { initSlashCommands } from "./util/slashCommands.js";

// Setup
export const extensionName = "Recast";
const extensionFolderPath = `scripts/extensions/third-party/recast-post-processing`;
const extensionSettings = extension_settings[extensionName];

// Starting variables
const recentProcessedMessages = new Set(); // Per message cooldown. Making sure other extensions won't trigger the pipeline twice. Yeah I know...
let isProcessing = false;
let currentMessageId = null;
// Set by GENERATION_STARTED so the MutationObserver can hide the incoming AI message block before streaming
let hideNextAiMessage = false;
let skipGenTypecheck = false;
// Intercept observer that blanks streaming tokens into .mes_text while the pipeline is pending
let streamInterceptObserver = null;
let isResettingStream = false;
let isPipelineCancelled = false;
let lastGenerationType = null;

// Pass utility and macro
const PassResults = {};
let LatestResult = "";
let _passSnapshots = [];
let _passNames = [];

// Per-message state storage for diff viewer
const _messageStates = {};

// Base functions
// Utility to get ST variables
function getST() {
    return getContext();
}

// Debug function ofc
export function logDebug(...args) {
    if (extension_settings[extensionName].debug_mode) {
        console.log("[Recast Debug]", ...args);
    }
}

// CONNECTION PROFILE MANAGER STUFF
function getErrorStatusCode(error) {
    return error?.response?.status
        ?? error?.status
        ?? error?.error?.status
        ?? error?.cause?.status
        ?? error?.cause?.response?.status
        ?? null;
}

function shouldRetryRequest(error) {
    const StatusCode = getErrorStatusCode(error);
    return StatusCode === 400 || StatusCode === 401 || StatusCode === 403;
}

function isConnectionManagerActive(st) {
    return !st?.extensionSettings?.disabledExtensions?.includes('connection-manager')
        && !!st?.extensionSettings?.connectionManager;
}

function getConnectionProfiles(st) {
    if (!isConnectionManagerActive(st)) {
        return [];
    }
    return st.extensionSettings.connectionManager.profiles || [];
}

function hasConnectionProfile(st, profileId) {
    if (!profileId) return true;
    const Profiles = getConnectionProfiles(st);
    return Profiles.some(p => p.id === profileId);
}

function parse_reasoning(text, profile_id) { // thanks qvink
    let ctx = getST();
    
    if (typeof ctx.parseReasoningFromString !== 'function' || typeof ctx.getReasoningTemplateByName !== 'function') {
        return text;
    }

    const Profiles = getConnectionProfiles(ctx);
    let profile_data = Profiles.find(p => p.id === profile_id);
    if (!profile_data) return text;

    let template_name = profile_data["reasoning-template"];
    if (!template_name) {
        logDebug("No reasoning template specified in profile");
        return text;
    }

    let template = ctx.getReasoningTemplateByName(template_name);
    if (!template) return text;

    let parsed = ctx.parseReasoningFromString(text, {}, template);
    if (!parsed?.reasoning) return text;  // no reasoning

    logDebug("Parsed reasoning: ", parsed);
    return parsed.content || text;
}

function getProfileNameById(st, profileId) {
    if (!profileId) return null;
    const Profiles = getConnectionProfiles(st);
    const profile = Profiles.find(p => p.id === profileId);
    return profile ? profile.name : null;
}

function resolveConnectionProfile(st, preferredProfileId = "") {
    const SelectedProfile = st?.extensionSettings?.connectionManager?.selectedProfile || "";

    if (!isConnectionManagerActive(st)) {
        return "";
    }

    if (preferredProfileId && hasConnectionProfile(st, preferredProfileId)) {
        return preferredProfileId;
    }

    if (preferredProfileId && !hasConnectionProfile(st, preferredProfileId)) {
        logDebug(`Requested profile '${preferredProfileId}' not found. Falling back to current profile.`);
    }

    if (SelectedProfile && hasConnectionProfile(st, SelectedProfile)) {
        return SelectedProfile;
    }

    return "";
}

function showErrorToast(passName, error) {
    if (typeof toastr !== 'undefined' && toastr.error) {
        let errorMsg = error.message || String(error);
        const statusCode = getErrorStatusCode(error);

        // If it's an object with nothing useful, try to stringify
        if (errorMsg === "[object Object]") {
            try {
                errorMsg = JSON.stringify(error);
            } catch (e) {
                errorMsg = "Unknown object error";
            }
        }

        // Sometimes API errors have detailed objects inside
        if (error.response && error.response.data) {
            try {
                errorMsg += "\nDetails: " + JSON.stringify(error.response.data);
            } catch(e) {}
        } else if (error.error && error.error.message) {
            errorMsg += "\nDetails: " + error.error.message;
        } else if (error.message && Object.keys(error).length > 1) {
            // It has a message but maybe more details
            try {
                // Avoid circular structures, but try to extract more details
                const cleanErr = { ...error };
                delete cleanErr.message;
                delete cleanErr.stack;
                if (Object.keys(cleanErr).length > 0) {
                    errorMsg += "\nDetails: " + JSON.stringify(cleanErr);
                }
            } catch(e) {}
        }

        if (statusCode !== null && statusCode !== undefined) {
            errorMsg = `HTTP ${statusCode}: ${errorMsg}`;
        }

        toastr.error(`Check your Connection Profile. Error in pass "${passName}": ${errorMsg}`, "Recast Error", { timeOut: 10000 });
    }
}

// CORE Silly
// setButtonState AKA block all generations. If there's any other better way to do this please tell me... It has to yield other extensions like qvink and vectorization.
function setButtonState(state) { // False unlocks, true locks it
    if (typeof setSendButtonState === 'function') {
        setSendButtonState(state);
    }

    if (!state) {
        showSwipeButtons() // Oh my god wolf is godsend
    }
}

// Makes sure to update the message in chat. Had a lot of trouble in the past with this so there may be a bit too much stuff
function safeUpdateMessageText(mesId, msg) {
    try {
        updateMessageBlock(mesId, msg);
    } catch (e) {
        console.warn("Recast: Non-fatal error in updateMessageBlock", e);
    }

    const mesEl = $(`#chat .mes[mesid="${mesId}"]`);
    if (mesEl.length > 0) {
        const mesTextEl = mesEl.find('.mes_text');
        if (mesTextEl.length > 0) {
            mesTextEl.empty();
            mesEl.find('.mes_edit_buttons').css('display', 'none');
            mesEl.find('.mes_buttons').css('display', '');
            mesTextEl.append(
                messageFormatting(
                    msg.mes,
                    msg.name,
                    msg.is_system,
                    msg.is_user,
                    mesId,
                    {},
                    false
                )
            );
        }
        
        const mesBiasEl = mesEl.find('.mes_bias');
        if (mesBiasEl.length > 0) {
            mesBiasEl.empty();
            if (msg.extra?.bias) {
                mesBiasEl.append(messageFormatting(msg.extra.bias, '', false, false, -1, {}, false));
            }
        }
    }
    
     //try {
    //    redisplayChat(); // Setup Here
    //} catch (e) {
    //    console.warn("Recast: Non-fatal error in redisplayChat", e);
    //}

    // This may fire extensions twice? Hopefully no one complains
    const st = getST();
    if (st.eventSource && st.event_types?.MESSAGE_EDITED) {
        try {
            st.eventSource.emit(st.event_types.MESSAGE_EDITED, mesId);
        } catch (e) {
            console.warn("Recast: Non-fatal error emitting MESSAGE_EDITED", e);
        }
    }
}

// PRESET stuff
function populateConnectionDropdown(selectElement, currentValue) {
    const st = getST();
    selectElement.empty();
    selectElement.append($("<option></option>").val("").text("Same as Current"));
    
    // Check if connection profiles extension is active
    if (!st.extensionSettings.disabledExtensions.includes('connection-manager') && st.extensionSettings.connectionManager && st.extensionSettings.connectionManager.profiles) {
        const profiles = st.extensionSettings.connectionManager.profiles;
        profiles.forEach(p => {
            selectElement.append($("<option></option>").val(p.id).text(p.name));
        });
    }

    // Attempt to select the value if it exists
    if (currentValue) {
        selectElement.val(currentValue);
    } else {
        selectElement.val("");
    }
}

// PASS Setup
function addPassToUI(pass = null) {
    if (!pass) {
        pass = {
            id: "pass_" + Date.now(),
            name: "New Pass",
            enabled: true,
            contextLength: 3,
            prompt: "",
            connection: "",
            injectWorldInfo: false,
            includeCharCard: true,
            includeSceneContext: true
        };
    }
    
    const template = document.getElementById("recast_pass_template");
    const clone = template.content.cloneNode(true);
    const item = $(clone).find(".recast-pass-item");
    
    item.data("id", pass.id);
    item.find(".pass-name").val(pass.name);
    item.find(".pass-enabled").prop("checked", pass.enabled);
    item.find(".pass-context-length").val(pass.contextLength);
    item.find(".pass-prompt").val(pass.prompt);
    
    const connectionSelect = item.find(".pass-connection");
    populateConnectionDropdown(connectionSelect, pass.connection);

    item.find(".pass-inject-world-info").prop("checked", pass.injectWorldInfo || false);
    item.find(".pass-inject-wi-outlets").prop("checked", pass.injectWIOutlets || false);
    item.find(".pass-include-char-card").prop("checked", pass.includeCharCard !== undefined ? pass.includeCharCard : true);
    item.find(".pass-include-scene-context").prop("checked", pass.includeSceneContext !== undefined ? pass.includeSceneContext : true);

    item.find(".pass-menu-btn").on("click", function(e) {
        e.stopPropagation();
        const dropdown = $(this).siblings(".pass-menu-dropdown");
        $(".pass-menu-dropdown").not(dropdown).hide();
        dropdown.toggle();
    });

    item.find(".pass-menu-dropdown").on("click", function(e) {
        e.stopPropagation();
    });

    item.find(".pass-remove").on("click", function() {
        $(this).closest(".recast-pass-item").remove();
        saveSettings();
    });
    
    item.find(".pass-toggle-details").on("click", function() {
        $(this).closest(".recast-pass-item").find(".recast-pass-details").toggle(); 
        $(this).toggleClass("fa-chevron-down fa-chevron-up");
    });
    
    item.find("input, select, textarea").on("change input", saveSettings);
    
    $("#recast_pass_list").append(item);
}


// MAIN
export async function runPass(pass, text, onChunk = null) {
    if (!pass.enabled) return text;

    const st = getST();
    const charId = st.characterId;
    const char = st.characters[charId];

    const IncludeCharCard = pass.includeCharCard !== undefined ? pass.includeCharCard : true;
    const IncludeSceneContext = pass.includeSceneContext !== undefined ? pass.includeSceneContext : true;

    let systemPrompt = pass.prompt.trim();

    // Fetch WI if: injectWorldInfo is on, injectWIOutlets is on, OR the prompt explicitly contains {{outlet:...}} placeholders.
    // Allow any number of colons after "outlet:" so both {{outlet:name}} and {{outlet::name}} work.
    const OutletMatches = [...systemPrompt.matchAll(/\{\{outlet::*([^}]+)\}\}/g)].map(m => m[1]);
    const HasOutletPlaceholders = OutletMatches.length > 0;
    const NeedsWI = (pass.injectWorldInfo || pass.injectWIOutlets || HasOutletPlaceholders) && typeof getWorldInfoPrompt === 'function';
    logDebug(`Pass ${pass.name}: NeedsWI=${NeedsWI}, HasOutletPlaceholders=${HasOutletPlaceholders}, outlets found in prompt:`, OutletMatches);
    if (NeedsWI) {
        try {
            const chatStrings = st.chat.slice().reverse().map(msg => msg.mes);
            const wiResult = await getWorldInfoPrompt(chatStrings, 100000, true);
            logDebug(`Pass ${pass.name}: WI result:`, wiResult);
            if (typeof wiResult === 'object' && wiResult !== null) {
                // Append worldInfoBefore/After only when injectWorldInfo is enabled
                if (pass.injectWorldInfo) {
                    const wiBefore = wiResult.worldInfoBefore || "";
                    const wiAfter = wiResult.worldInfoAfter || "";
                    const wiText = (wiBefore + "\n" + wiAfter).trim();
                    if (wiText.length > 0) {
                        systemPrompt += `\n\n<world_info>\n${wiText}\n</world_info>`;
                        logDebug(`Pass ${pass.name}: World Info injected.`);
                    }
                }

                // Replace {{outlet:name}} or {{outlet::name}} placeholders — always when present, or injectWIOutlets is on
                const outletEntries = wiResult.outletEntries || {};
                logDebug(`Pass ${pass.name}: Available outlet entries:`, Object.keys(outletEntries));
                const InjectedOutlets = new Set();
                if (pass.injectWIOutlets || HasOutletPlaceholders) {
                    for (const [outletName, contents] of Object.entries(outletEntries)) {
                        const outletText = Array.isArray(contents) ? contents.join("\n") : String(contents);
                        // Match both {{outlet:name}} and {{outlet::name}} (any number of colons)
                        const PlaceholderRegex = new RegExp(`\\{\\{outlet::*${outletName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
                        if (PlaceholderRegex.test(systemPrompt)) {
                            systemPrompt = systemPrompt.replace(PlaceholderRegex, outletText);
                            InjectedOutlets.add(outletName);
                            logDebug(`Pass ${pass.name}: Outlet '${outletName}' replaced via placeholder.`);
                        }
                    }
                    // Warn about any remaining unresolved outlet placeholders
                    const Unresolved = [...systemPrompt.matchAll(/\{\{outlet::*([^}]+)\}\}/g)].map(m => m[1]);
                    if (Unresolved.length > 0) {
                        logDebug(`Pass ${pass.name}: Unresolved outlet placeholders (no matching WI outlet entry):`, Unresolved);
                    }
                }

                // When injectWIOutlets is on, auto-append any outlets that were NOT injected via a placeholder
                if (pass.injectWIOutlets) {
                    for (const [outletName, contents] of Object.entries(outletEntries)) {
                        if (InjectedOutlets.has(outletName)) continue;
                        const outletText = Array.isArray(contents) ? contents.join("\n") : String(contents);
                        systemPrompt += `\n\n<outlet name="${outletName}">\n${outletText}\n</outlet>`;
                        logDebug(`Pass ${pass.name}: Outlet '${outletName}' auto-appended to prompt.`);
                    }
                }
            }
        } catch (e) {
            console.error("Recast: Error fetching World Info for pass " + pass.name, e);
        }
    }

    // Always substitute ST macros in the system prompt
    if (typeof MacrosParser !== 'undefined' && typeof MacrosParser.parseMacros === 'function') {
        systemPrompt = MacrosParser.parseMacros(systemPrompt);
        logDebug(`Pass ${pass.name}: Macros substituted in system prompt.`);
    }

    // Build user message using XML-tagged sections for clear isolation between data types
    const UserParts = [];

    if (IncludeCharCard && char) {
        const CharCardLines = [
            char.name        ? `<name>${char.name}</name>`                                           : "",
            char.description ? `<description>${char.description}</description>`                     : "",
            char.personality ? `<personality>${char.personality}</personality>`                     : "",
            char.scenario    ? `<scenario>${char.scenario}</scenario>`                               : "",
            char.mes_example ? `<example_dialogue>\n${char.mes_example}\n</example_dialogue>`       : ""
        ].filter(Boolean).join("\n");
        if (CharCardLines.trim()) {
            UserParts.push(`<characters>\n${CharCardLines}\n</characters>`);
        }
    }

    // This needs to become a bit more fancy
    if (IncludeSceneContext && pass.contextLength > 0) {
        const CharName = char ? char.name : "Assistant";
        const History = st.chat.slice(-(pass.contextLength + 1), -1);
        if (History.length > 0) {
            const SceneContext = History.map(m => `${m.name}: ${m.mes}`).join("\n");
            UserParts.push(`<scene_context>\n${SceneContext}\n</scene_context>`);
        }
    }

    UserParts.push(`<text_to_transform>\n${text}\n</text_to_transform>`);
    const userPrompt = UserParts.join("\n\n");

    try {
        logDebug(`Running pass ${pass.name}...`);
        logDebug("System prompt:", systemPrompt);
        logDebug("User prompt:", userPrompt);

        const ConnectionProfile = resolveConnectionProfile(st, pass.connection || "");
        const TargetProfileName = getProfileNameById(st, ConnectionProfile);
        const OriginalProfileName = st.extensionSettings?.connectionManager?.selectedProfileName || getProfileNameById(st, resolveConnectionProfile(st, ""));

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ];

        let result = "";
        let swappedProfile = false;

        async function requestPass(connectionProfileId, streamMode) {
            if (extension_settings[extensionName].legacy_api) {
                if (TargetProfileName && TargetProfileName !== OriginalProfileName) {
                    const swapSuccess = await swapProfile(TargetProfileName, OriginalProfileName);
                    if (swapSuccess) {
                        swappedProfile = true;
                    }
                }
            }

            if (!st.ConnectionManagerRequestService || !st.ConnectionManagerRequestService.sendRequest) {
                throw new Error("ConnectionManagerRequestService.sendRequest is unavailable.");
            }

            logDebug(`Pass ${pass.name}: sendRequest profile='${connectionProfileId || "<same-as-current>"}', stream=${streamMode}`);

            const createGenerator = await st.ConnectionManagerRequestService.sendRequest(
                connectionProfileId,
                messages,
                undefined,
                { stream: streamMode }
            );

            if (typeof createGenerator === 'function') {
                const generator = createGenerator();
                let streamResult = "";
                for await (const chunk of generator) {
                    if (isPipelineCancelled) {
                        logDebug(`Pass ${pass.name}: stream aborted by isPipelineCancelled.`);
                        break;
                    }
                    if (chunk && chunk.text !== undefined) {
                        streamResult = chunk.text;
                        if (onChunk) {
                            onChunk(streamResult);
                        }
                    }
                }
                return streamResult;
            }

            if (createGenerator && typeof createGenerator === 'object') {
                const fallbackResult = createGenerator.content || createGenerator.text || String(createGenerator);
                if (onChunk) onChunk(fallbackResult);
                return fallbackResult;
            }

            return "";
        }
        
        const isPipelineStreamingEnabled = extension_settings[extensionName].stream_pipeline && isSTStreamingEnabled();

        try {
            result = await requestPass(ConnectionProfile, isPipelineStreamingEnabled);
        } catch (firstError) {
            const fallbackProfile = resolveConnectionProfile(st, "");
            const retryWithFallbackProfile = shouldRetryRequest(firstError) && fallbackProfile !== ConnectionProfile;
            const retryWithoutStreaming = isPipelineStreamingEnabled; // fixing undefined variable

            if (retryWithFallbackProfile || retryWithoutStreaming) {
                const RetryProfile = retryWithFallbackProfile ? fallbackProfile : ConnectionProfile;
                const RetryStream = retryWithoutStreaming ? false : isPipelineStreamingEnabled;
                logDebug(
                    `Pass ${pass.name}: first request failed (status=${getErrorStatusCode(firstError) ?? "unknown"}). ` +
                    `Retrying with profile='${RetryProfile || "<same-as-current>"}', stream=${RetryStream}`
                );
                result = await requestPass(RetryProfile, RetryStream);
            } else {
                throw firstError;
            }
        } finally {
            if (swappedProfile && OriginalProfileName) {
                await swapProfile(OriginalProfileName, TargetProfileName);
            }
        }

        result = parse_reasoning(result, ConnectionProfile);
        logDebug("Pass result:", result);
        return result || text;
    } catch (e) {
        console.error("Recast: Error in pass " + pass.name, e);
        showErrorToast(pass.name, e);
        return text;
    }
}

// MAIN PIPELINE thread
export async function runPipeline(originalText, messageId, skipHide = false, prefixText = "") {
    if (isProcessing) return { skipped: true, reason: 'busy' };
    if (!extension_settings[extensionName].enabled) return { skipped: true, reason: 'disabled' };

    const MinChars = extension_settings[extensionName].min_chars ?? 0;
    if (MinChars > 0 && originalText.trim().length < MinChars) {
        logDebug(`Skipping pipeline: text length ${originalText.trim().length} is below min_chars (${MinChars}).`);
        return { skipped: true, reason: 'min_chars' };
    }

    isProcessing = true;
    currentMessageId = messageId;
    isPipelineCancelled = false;
    
    const idx = presetManager.getActivePresetIndex();
    if (idx === -1) {
        isProcessing = false;
        return { skipped: true, reason: 'no_preset' };
    }
    
    setButtonState(true); // Locks generation - I think?
    
    const preset = extension_settings[extensionName].presets[idx];
    let currentText = originalText;
    _passSnapshots = [prefixText + originalText];

    const enabledPasses = preset.passes.filter(p => p.enabled);
    _passNames = enabledPasses.map(p => p.name);
    
    if (enabledPasses.length > 0) {
        pipelineBar.start(enabledPasses.length, currentText);

        if (!skipHide && extension_settings[extensionName].hide_until_last && currentMessageId !== null) {
            const mesEl = document.querySelector(`.mes[mesid="${currentMessageId}"]`);
            const mesTextEl = mesEl?.querySelector('.mes_text');
            if (mesTextEl) mesTextEl.innerHTML = '';
        }
    }

    //
    let completedPassesCount = 0;

    for (let i = 0; i < enabledPasses.length; i++) {
        if (isPipelineCancelled) {
            logDebug("Pipeline cancelled by user.");
            currentText = originalText;
            break;
        }
        
        const pass = enabledPasses[i];
        pipelineBar.updatePass(i, pass.name);
        
        const isLastPass = i === enabledPasses.length - 1;
        const hideUntilLast = extension_settings[extensionName].hide_until_last;
        const isPipelineStreamingEnabled = extension_settings[extensionName].stream_pipeline && isSTStreamingEnabled();

        const shouldStreamInline = isPipelineStreamingEnabled && (isLastPass || !hideUntilLast) && currentMessageId !== null;

        let lastRegexTime = 0;
        let lastRegexResult = "";
        let lastRegexChunkLength = 0;
        const REGEX_THROTTLE_MS = 1000

        const onChunk = (chunkText) => {
            pipelineBar.updateChunk(chunkText);
            
            if (shouldStreamInline) {
                const now = performance.now();
                let textToRender = chunkText;

                // Only run heavy ST Regex passes periodically
                if (now - lastRegexTime > REGEX_THROTTLE_MS) {
                    lastRegexResult = applySTRegex(chunkText);
                    lastRegexChunkLength = chunkText.length;
                    lastRegexTime = now;
                }
                
                // Append any new un-regexed tokens that arrived during the cooldown
                if (lastRegexResult) {
                    textToRender = lastRegexResult + chunkText.slice(lastRegexChunkLength);
                }

                const msg = getST().chat[currentMessageId];
                if (msg) {
                    msg.mes = prefixText + textToRender;

                    const mesEl = document.querySelector(`#chat .mes[mesid="${currentMessageId}"]`);
                    const mesTextEl = mesEl?.querySelector('.mes_text');
                    
                    if (mesTextEl) {
                        const formattedText = messageFormatting(
                            textToRender,
                            msg.name,
                            msg.is_system,
                            msg.is_user,
                            currentMessageId,
                            {},
                            false
                        );

                        if (power_user && power_user.stream_fade_in) {
                            applyStreamFadeIn(mesTextEl, formattedText);
                        } else {
                            mesTextEl.innerHTML = formattedText;
                        }
                    } else if (mesEl) {
                        updateMessageBlock(currentMessageId, msg);
                    }
                }
            }
        };

        // Pipeline Startup
        const RawPassResult = await runPass(pass, currentText, onChunk);
        
        if (isPipelineCancelled) {
            logDebug("Pipeline cancelled during pass execution.");
            currentText = originalText;
            // Restore original text directly
            const msg = getST().chat[currentMessageId];
            if (msg) {
                msg.mes = originalText;
                safeUpdateMessageText(currentMessageId, msg);
            }
            break;
        }

        // Run regex on result
        const RegexedResult = applySTRegex(RawPassResult);
        
        // Run auto delete on result
        const AutoDeleteResult = applyAutoDelete(RegexedResult);

        if (AutoDeleteResult.trim().length === 0) {
            logDebug(`Pass ${pass.name}: result was empty after auto delete — keeping previous text.`);
        } else {
            currentText = AutoDeleteResult;
        }

        PassResults[pass.id] = currentText;
        completedPassesCount++;
        _passSnapshots.push(prefixText + currentText);
        pipelineBar.finishPass(currentText);

        // Ensure final state of the pass is updated
        if (shouldStreamInline) {
            const msg = getST().chat[currentMessageId];
            if (msg) {
                msg.mes = prefixText + currentText;
                
                if (onChunk && power_user && power_user.stream_fade_in) {
                    // Update DOM directly one last time to avoid abruptly overwriting the fade-in animation via updateMessageBlock
                    const mesEl = document.querySelector(`#chat .mes[mesid="${currentMessageId}"]`);
                    const mesTextEl = mesEl?.querySelector('.mes_text');
                    if (mesTextEl) {
                        const formattedText = messageFormatting(msg.mes, msg.name, msg.is_system, msg.is_user, currentMessageId, {}, false);
                        applyStreamFadeIn(mesTextEl, formattedText);
                    } else {
                        updateMessageBlock(currentMessageId, msg);
                    }
                } else {
                    safeUpdateMessageText(currentMessageId, msg);
                }
            }
        }
    }

    // Wrapping up
    const finalFullText = prefixText + currentText; // Prefix text is for continue stuff btw.
    const originalFullText = prefixText + originalText;

    LatestResult = finalFullText;

    if (enabledPasses.length > 0) {
        pipelineBar.complete();
    }

    // Backup
    if (completedPassesCount === 0) {
        if (currentMessageId !== null) {
            const msg = getST().chat[currentMessageId];
            if (msg) {
                msg.mes = originalFullText;
                safeUpdateMessageText(currentMessageId, msg);
            }
        }
        setButtonState(false);
        isProcessing = false;
        return { skipped: true, reason: 'zero_passes' };
    }
    
    // Always save state and update icon
    logDebug("Pipeline finished, saving state for mesId:", currentMessageId);
    if (currentMessageId !== null) {
        _messageStates[currentMessageId] = {
            originalText: originalFullText,
            transformedText: finalFullText,
            passSnapshots: [..._passSnapshots],
            passNames: [..._passNames],
            stepEdits: {},
            state: "blue"
        };
    }
    saveMessageStates();

    // Restore original text
    if (currentMessageId !== null) {
        const msg = getST().chat[currentMessageId];
        if (msg) {
            msg.mes = originalFullText;
            safeUpdateMessageText(currentMessageId, msg);
        }
    }

    // Update icon AFTER safeUpdateMessageText
    logDebug("Updating button state to blue for mesId:", currentMessageId);
    if (currentMessageId !== null) {
        updateMessageButtonState(currentMessageId, "blue");
    }

    // When skipHide is active, the caller (MESSAGE_RECEIVED) handles the diff modal
    if (skipHide) {
        logDebug("skipHide is true, returning early");
        return finalFullText;
    }

    // Always show diff modal for user review
    logDebug("Showing diff modal");
    try {
        showDiffModal(originalFullText, finalFullText, (newText) => {
            showAcceptWarning(currentMessageId, newText);
            setButtonState(false);
            isProcessing = false;
        }, () => {
            if (currentMessageId !== null) {
                const restoreMsg = getST().chat[currentMessageId];
                if (restoreMsg) {
                    restoreMsg.mes = originalFullText;
                    safeUpdateMessageText(currentMessageId, restoreMsg);
                    getST().saveChat();
                }
            }
            setButtonState(false);
            isProcessing = false;
        }, _passSnapshots, _passNames, null, () => {
            setButtonState(false);
            isProcessing = false;
        });
    } catch (e) {
        console.error("[Recast] Error showing diff modal:", e);
        setButtonState(false);
        isProcessing = false;
    }
    
    return finalFullText;
}

// OTHER

// Diff
function acceptChanges(newText) {
    if (currentMessageId !== null) {
        const msg = getST().chat[currentMessageId];
        if (msg) {
            msg.mes = newText;
            safeUpdateMessageText(currentMessageId, msg);
            getST().saveChat();
        }
    }
    setButtonState(false);
    isProcessing = false;
}

// REGEX
function applySTRegex(text) {
    try {
        if (typeof getRegexedString === "function") {
            const Result = getRegexedString(text, regex_placement.AI_OUTPUT);
            logDebug("ST regex applied:", Result);
            return Result ?? text;
        }
    } catch (e) {
        console.error("Recast: Error applying ST regex:", e);
    }
    return text;
}

// AUTO DELETE
function applyAutoDelete(text) {
    // 字面量模式 - 直接匹配文本
    let literalList = extension_settings[extensionName]?.auto_delete_literal;
    if (literalList) {
        literalList = literalList.replace(/\\n/g, '\n');
        const escaped = literalList.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'g'), '');
    }
    
    // 正则模式 - 支持正则表达式
    let deleteList = extension_settings[extensionName]?.auto_delete;
    if (deleteList) {
        deleteList = deleteList.replace(/\\n/g, '\n');
        try {
            text = text.replace(new RegExp(deleteList, 'g'), '');
        } catch (e) {
            console.error('Recast: Invalid regex in auto_delete:', e);
        }
    }
    
    // 清理连续空行（2行及以上变1行）
    text = text.replace(/\n{3,}/g, '\n\n');
    
    return text;
}

// MACROS
// Register Recast macros with ST's MacrosParser.
// {{recast_latest}}        — full text output from the last completed pipeline run
// {{recast_<pass_id>}}     — output of a specific pass from the last pipeline run
function registerMacros() {
    if (typeof MacrosParser === 'undefined' || typeof MacrosParser.addMacro !== 'function') {
        logDebug("MacrosParser not available, skipping macro registration.");
        return;
    }

    MacrosParser.addMacro("recast_latest", () => LatestResult);

    const idx = presetManager.getActivePresetIndex();
    if (idx === -1) return;

    const Passes = extension_settings[extensionName].presets[idx].passes;
    Passes.forEach(pass => {
        MacrosParser.addMacro(`recast_${pass.id}`, () => PassResults[pass.id] || "");
    });

    logDebug("Macros registered:", ["recast_latest", ...Passes.map(p => `recast_${p.id}`)]);
}

// Message button state management (module-level so runPipeline can access)
function updateMessageButtonState(mesId, state) {
    const mesIdStr = String(mesId);
    const mesEl = $(`.mes[mesid="${mesIdStr}"]`);
    const btn = mesEl.find(".recast-msg-btn");
    btn.removeClass("recast-state-blue recast-state-green");
    if (state === "blue") {
        btn.addClass("recast-state-blue");
    } else if (state === "green") {
        btn.addClass("recast-state-green");
    }
}

function saveMessageStates() {
    extension_settings[extensionName].messageStates = { ..._messageStates };
    saveSettingsDebounced();
}

function showAcceptWarning(mesId, newText) {
    const dialogHtml = `
        <div id="recast_accept_warning" class="recast-dialog-backdrop" style="display:none;">
            <div class="recast-dialog-wrapper">
                <div class="rc-diff-header">
                    <span class="rc-diff-title">Confirm Apply Changes</span>
                    <button id="recast_accept_close" class="rc-diff-close-btn" title="Cancel"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="recast-dialog-body">Cannot re-select after confirmation.</div>
                <div class="rc-diff-footer">
                    <button id="recast_accept_cancel" class="menu_button red_button rc-diff-btn"><i class="fa-solid fa-xmark"></i> Cancel</button>
                    <button id="recast_accept_confirm" class="menu_button rc-diff-btn rc-diff-accept-btn"><i class="fa-solid fa-check"></i> Confirm</button>
                </div>
            </div>
        </div>
    `;
    
    $("body").append(dialogHtml);
    $("#recast_accept_warning").fadeIn(200);

    $("#recast_accept_confirm").on("click", function() {
        if (_messageStates[mesId]) {
            _messageStates[mesId].stepEdits = getStepEdits();
        }
        $("#recast_accept_warning").fadeOut(200, function() { $(this).remove(); });
        hideDiffModal(false);
        acceptChangesForMessage(mesId, newText);
    });

    $("#recast_accept_cancel, #recast_accept_close").on("click", function() {
        $("#recast_accept_warning").fadeOut(200, function() { $(this).remove(); });
    });
}

function acceptChangesForMessage(mesId, newText) {
    const st = getST();
    const msg = st.chat[mesId];
    if (msg) {
        msg.mes = newText;
        safeUpdateMessageText(parseInt(mesId, 10), msg);
        st.saveChat();
    }

    if (_messageStates[mesId]) {
        _messageStates[mesId].state = "green";
        _messageStates[mesId].transformedText = newText;
    }
    updateMessageButtonState(mesId, "green");
    saveMessageStates();
}

function showGreenStateOptions(mesId) {
    const dialogHtml = `
        <div id="recast_undo_dialog" class="recast-dialog-backdrop" style="display:none;">
            <div class="recast-dialog-wrapper">
                <div class="rc-diff-header">
                    <span class="rc-diff-title">Changes Applied</span>
                    <button id="recast_undo_close" class="rc-diff-close-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="recast-dialog-body">Confirm or undo changes</div>
                <div class="rc-diff-footer">
                    <button id="recast_undo_confirm" class="menu_button rc-diff-btn rc-diff-accept-btn"><i class="fa-solid fa-check"></i> Confirm</button>
                    <button id="recast_undo_cancel" class="menu_button red_button rc-diff-btn"><i class="fa-solid fa-xmark"></i> Undo changes</button>
                </div>
            </div>
        </div>
    `;
    
    $("body").append(dialogHtml);
    $("#recast_undo_dialog").fadeIn(200);

    $("#recast_undo_confirm").on("click", function() {
        if (_messageStates[mesId]) {
            _messageStates[mesId].state = "grey";
        }
        updateMessageButtonState(mesId, "grey");
        saveMessageStates();
        $("#recast_undo_dialog").fadeOut(200, function() { $(this).remove(); });
    });

    $("#recast_undo_cancel").on("click", function() {
        $("#recast_undo_dialog").fadeOut(200, function() { $(this).remove(); });
        undoChanges(mesId);
    });

    $("#recast_undo_close").on("click", function() {
        $("#recast_undo_dialog").fadeOut(200, function() { $(this).remove(); });
    });
}

function undoChanges(mesId) {
    const state = _messageStates[mesId];
    if (!state) return;

    const st = getST();
    const msg = st.chat[mesId];
    if (msg) {
        msg.mes = state.originalText;
        safeUpdateMessageText(parseInt(mesId, 10), msg);
        st.saveChat();
    }

    _messageStates[mesId].state = "grey";
    updateMessageButtonState(mesId, "grey");
    saveMessageStates();
    toastr.info("Original text restored");
}

function openDiffWindow(mesId) {
    const state = _messageStates[mesId];
    if (!state) return;

    showDiffModal(state.originalText, state.transformedText, (newText) => {
        showAcceptWarning(mesId, newText);
        setButtonState(false);
        isProcessing = false;
    }, () => {
        runPipeline(state.originalText, parseInt(mesId, 10));
    }, state.passSnapshots, state.passNames, state.stepEdits, () => {
        setButtonState(false);
        isProcessing = false;
    });
}

// Startup
jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);
    const tempDiv = $('<div>').html(settingsHtml);
    
    // Progress Bar and stuff
    const progressBar = tempDiv.find("#recast_progress_bar");
    const diffBackdrop = tempDiv.find("#recast_diff_backdrop");
    const diffModal = tempDiv.find("#recast_diff_modal");
    
    $("body").append(progressBar);
    
    pipelineBar.init(() => {
        isPipelineCancelled = true;
        isProcessing = false;
        setButtonState(false);
        logDebug("Pipeline cancelled by user via stop button.");
    });

    $("body").append(diffBackdrop);
    $("body").append(diffModal);
    $("body").append(tempDiv.find("#recast_preset_manager_modal"));
    
    // Edit modal
    const editBackdrop = tempDiv.find("#recast_edit_backdrop");
    const editModal = tempDiv.find("#recast_edit_modal");
    $("body").append(editBackdrop);
    $("body").append(editModal);
    
    // Append the rest to extensions settings
    $("#extensions_settings").append(tempDiv.children());

    presetManager.init(addPassToUI, saveSettings);
    loadSettings();
    initSettingsListeners();
    registerMacros();
    initDiffViewer();
    initSlashCommands();
    
    // Pass Buttons
    $("#recast_add_pass").on("click", () => {
        addPassToUI();
        saveSettings();
    });
    
    $("#recast_run_pipeline").on("click", () => {
        if (!extension_settings[extensionName].enabled) {
            toastr.warning("Recast extension is currently disabled.");
            return;
        }
        const st = getST();
        const mesId = st.chat.length - 1;
        const lastMsg = st.chat[mesId];
        if (lastMsg && !lastMsg.is_user) {
            runPipeline(lastMsg.mes, mesId);
        } else {
            toastr.warning("No AI message found to process.");
        }
    });
    
    // Drag and drop sortable list
    $("#recast_pass_list").sortable({
        handle: ".fa-grip-vertical",
        update: saveSettings
    });

    $(document).on("click", function() {
        $(".pass-menu-dropdown").hide();
    });

    // BUTTON cool button stuff
    function injectMessageTemplateButton() {
        const html = `<div title="Run Recast Pipeline on this message" class="mes_button recast-msg-btn interactable fa-solid fa-hand-sparkles" tabindex="0"></div>`;
        $("#message_template .mes_buttons .extraMesButtons").prepend(html);

        // Inject into any existing messages right now so we don't have to reload
        $("#chat .mes .extraMesButtons").each(function() {
            if ($(this).find(".recast-msg-btn").length === 0) {
                $(this).prepend(html);
            }
        });
    }

    injectMessageTemplateButton();

    // Restore message states from saved settings
    function restoreMessageStates() {
        const savedStates = extension_settings[extensionName].messageStates || {};
        for (const [mesId, state] of Object.entries(savedStates)) {
            _messageStates[mesId] = state;
            updateMessageButtonState(mesId, state.state);
        }
    }

    // Restore states on load
    restoreMessageStates();

    // Re-apply state colors when new messages appear in the DOM (async chat load)
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        new MutationObserver((mutations) => {
            const addedMes = mutations.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && n.matches('.mes')));
            if (addedMes) {
                for (const mesId of Object.keys(_messageStates)) {
                    updateMessageButtonState(mesId, _messageStates[mesId].state);
                }
            }
        }).observe(chatEl, { childList: true });
    }

    $(document).on("click", ".recast-msg-btn", function(e) {
        e.stopPropagation();
        if (!extension_settings[extensionName].enabled) {
            toastr.warning("Recast extension is currently disabled.");
            return;
        }

        const mesEl = $(this).closest('.mes');
        const mesId = mesEl.attr('mesid');
        const isUser = mesEl.attr('is_user') === 'true';

        if (isUser) {
            toastr.warning("Recast can only process AI messages.");
            return;
        }

        const st = getST();
        const msg = st.chat[mesId];
        if (!msg) {
            toastr.warning("Could not find message data.");
            return;
        }

        const state = _messageStates[mesId];

        // Blue state: open diff window
        if (state && state.state === "blue" && state.originalText && state.transformedText) {
            openDiffWindow(mesId);
            return;
        }

        // Green state: show undo option
        if (state && state.state === "green" && state.originalText) {
            showGreenStateOptions(mesId);
            return;
        }

        // Grey state: run pipeline
        runPipeline(msg.mes, parseInt(mesId, 10));
    });

    ///
    // DOM and Generation Stuff
    const st = getST();
    if (st.eventSource && st.event_types) { // bro is checking for nothing lmaoo // this is some real vibecode stuff
        // Helper: attach a MutationObserver on a .mes_text element that blanks any content
        function attachStreamIntercept(mesTextEl, preserveText = false) {
            if (streamInterceptObserver) streamInterceptObserver.disconnect();
            const originalHTML = preserveText ? mesTextEl.innerHTML : '';
            if (!preserveText) {
                mesTextEl.innerHTML = '';
            }
            
            const observerCallback = () => {
                if (isResettingStream) return;
                const mesId = mesTextEl.closest('.mes')?.getAttribute('mesid');
                if (mesId && recentProcessedMessages.has(parseInt(mesId, 10))) {
                    streamInterceptObserver.disconnect();
                    return;
                }
                
                isResettingStream = true;
                streamInterceptObserver.disconnect();
                mesTextEl.innerHTML = originalHTML;
                streamInterceptObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
                isResettingStream = false;
            };

            streamInterceptObserver = new MutationObserver(observerCallback);
            streamInterceptObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
        }

        // MutationObserver on #chat: intercept the new AI message node the instant it is
        // added to the DOM (before any streaming token renders) and blank its text.
        const chatDomEl = document.getElementById('chat');
        if (chatDomEl) {
            const chatObserver = new MutationObserver((mutations) => {
                if (!hideNextAiMessage) return;
                if (!extension_settings[extensionName].hide_until_last) return; // If the user doesn't want to hide anything in the first place, then this is useless.
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (
                            node.nodeType === Node.ELEMENT_NODE &&
                            node.classList.contains('mes') &&
                            node.getAttribute('is_user') !== 'true'
                        ) {
                            const mesId = node.getAttribute('mesid');
                            if (mesId && recentProcessedMessages.has(parseInt(mesId, 10))) return;
                            if (isProcessing) return; // Makes sure to not hide self
                            
                            // Compatibility module checks if this should run or not.
                            if (shouldSkipStreamIntercept(extension_settings[extensionName].compatibility_mode)) {
                                logDebug('Recast: skipping stream intercept because a compatible extension is running.');
                                return;
                            }
                            
                            hideNextAiMessage = false;
                            const mesTextEl = node.querySelector('.mes_text');
                            if (mesTextEl) {
                                attachStreamIntercept(mesTextEl);
                                logDebug('Recast: stream intercepted on new message — blanking until pipeline done.');
                            }
                            return;
                        }
                    }
                }
            });
            chatObserver.observe(chatDomEl, { childList: true });
        }

        // Pipeline
        async function triggerPipelineOnMessage(mesId) {
            const skip = skipGenTypecheck;
            skipGenTypecheck = false;

            if (!extension_settings[extensionName].autorun) { logDebug("triggerPipelineOnMessage: autorun disabled, returning"); return; }
            if (!skip && !['normal', 'swipe', 'regenerate', 'impersonate', 'continue'].includes(lastGenerationType)) { 
                logDebug(`triggerPipelineOnMessage: lastGenerationType ${lastGenerationType} not supported, returning`); 
                return; 
            }
            lastGenerationType = null; // Consume it so it doesn't leak into next call

            if (mesId === 0) { logDebug("triggerPipelineOnMessage: mesId is 0, returning"); return; } // uhh funny silly tavern

            const chat = getST().chat;
            const msg = chat[mesId];
            if (!msg || msg.is_user) { logDebug("triggerPipelineOnMessage: msg is null or is_user, returning"); return; }
            // Capture whether streaming was being intercepted (determines the display path)
            const isIntercepted = streamInterceptObserver !== null;
            // Save the original (unprocessed) text before the pipeline modifies it
            const originalText = msg.mes;

            // ST is done streaming — release the intercept lock NOW, before the pipeline runs.
            // This prevents any timing issue where a pending mutation callback could blank
            // content that streamResult writes after the pipeline.
            if (streamInterceptObserver) {
                streamInterceptObserver.disconnect();
                streamInterceptObserver = null;
                logDebug('Recast: stream intercept released at MESSAGE_RECEIVED.');
            }
            
            if (recentProcessedMessages.has(mesId)) { logDebug(`triggerPipelineOnMessage: mesId ${mesId} recently processed, returning`); return; }
            recentProcessedMessages.add(mesId);

            const result = await runPipeline(msg.mes, mesId, isIntercepted);
            
            setTimeout(() => recentProcessedMessages.delete(mesId), 5000); // this is some weird issue I can't seem to fix, so whatever make the message immune.

            if (result && result.skipped) {
                if (isIntercepted) {
                    // fix allat
                    safeUpdateMessageText(mesId, msg);
                    setButtonState(false);
                }
                // Do NOT set isProcessing to false if we didn't start the pipeline or didn't own the lock
                logDebug("triggerPipelineOnMessage: pipeline skipped, returning");
                return;
            }

            if (isIntercepted) {
                // When intercepted, runPipeline returned early (skipHide=true)
                // We need to show the diff modal here after a short delay
                setTimeout(() => {
                    showDiffModal(originalText, result, (newText) => {
                        showAcceptWarning(mesId, newText);
                        setButtonState(false);
                        isProcessing = false;
                    }, () => {
                        const restoreMsg = getST().chat[mesId];
                        if (restoreMsg) {
                            restoreMsg.mes = originalText;
                            safeUpdateMessageText(mesId, restoreMsg);
                            getST().saveChat();
                        }
                        setButtonState(false);
                        isProcessing = false;
                    }, _passSnapshots, _passNames, null, () => {
                        setButtonState(false);
                        isProcessing = false;
                    });
                }, 500);
            } else {
                // When not intercepted, runPipeline already showed the diff modal
                // Nothing to do here
            }
        }

        // When generation starts, set up interception before any token arrives.
        st.eventSource.on(st.event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
            lastGenerationType = type;
            if (dryRun) return;
            if (!extension_settings[extensionName].enabled) return;
            if (!extension_settings[extensionName].autorun) return;
            if (!extension_settings[extensionName].hide_until_last) return;
            if (!['normal', 'swipe', 'regenerate', 'impersonate', 'continue'].includes(type)) return;

            // Only bother if there are passes that will actually run
            const idx = presetManager.getActivePresetIndex();
            if (idx === -1) return;
            const EnabledPasses = extension_settings[extensionName].presets[idx].passes.filter(p => p.enabled);
            if (EnabledPasses.length === 0) return;

            if (type === 'swipe' || type === 'regenerate' || type === 'continue') {
                // Swipe/regenerate update an existing element — blank its text directly now
                const st2 = getST();
                const mesId = st2.chat.length - 1;
                if (mesId >= 0 && st2.chat[mesId] && !st2.chat[mesId].is_user) {
                    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
                    const mesTextEl = mesEl?.querySelector('.mes_text');
                    if (mesTextEl) {
                        attachStreamIntercept(mesTextEl, type === 'continue');
                        logDebug(`Recast: [GENERATION_STARTED] stream intercepted on ${type} mesid=${mesId}.`);
                    }
                }
            } else {
                // New message: MutationObserver will catch it the instant the DOM node appears
                hideNextAiMessage = true;
                logDebug('Recast: set hideNextAiMessage=true for upcoming new AI message.');
            }
        });

        // MESSAGE_RECEIVED EVENT
        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (mesId) => {
            // Compatibility module checks if this should run or not.
            if (shouldIgnoreMessageReceived(extension_settings[extensionName].compatibility_mode)) {
                logDebug('Recast: ignoring MESSAGE_RECEIVED because a compatible extension is running.');
                return;
            }

            await triggerPipelineOnMessage(mesId);
        });

        // If generation is stopped/aborted, clean up the intercept and restore the raw content.
        st.eventSource.on(st.event_types.GENERATION_STOPPED, () => {
            hideNextAiMessage = false;
            isPipelineCancelled = true;
            if (streamInterceptObserver) {
                streamInterceptObserver.disconnect();
                streamInterceptObserver = null;
            }
            if (extension_settings[extensionName].hide_until_last && extension_settings[extensionName].autorun) {
                const st2 = getST();
                const mesId = st2.chat.length - 1;
                if (mesId >= 0 && st2.chat[mesId]) {
                    safeUpdateMessageText(mesId, st2.chat[mesId]);
                    logDebug(`Recast: generation stopped — restored content of mesid=${mesId}.`);
                }
            }
        });

        // Init compatibility listeners if mode is on, providing a callback to re-arm the hide flag
        if (extension_settings[extensionName].compatibility_mode) { // Makes sure Compatibility won't be touched unless the user enables it
            initCompatibilityListeners(() => {
                if (extension_settings[extensionName].enabled && extension_settings[extensionName].autorun && extension_settings[extensionName].compatibility_mode) {
                    logDebug(`Recast: Stepped Thinking released mutex.`);
                    skipGenTypecheck = true

                    // Stepped Thinking might take a few milliseconds to put the actual message in
                    //setTimeout(() => {
                        //const st2 = getST();
                        //const mesId = st2.chat.length;
                        //logDebug(`Recast: Stepped Thinking released mutex. Triggering Pipeline on mesid=${mesId}.`);
                        //triggerPipelineOnMessage(mesId, true);
                    //}, 200);
                }
            });
        }
    }
});
