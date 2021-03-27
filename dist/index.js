'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var prosemirrorState = require('prosemirror-state');
var prosemirrorView = require('prosemirror-view');
var prosemirrorTransform = require('prosemirror-transform');
var prosemirrorKeymap = require('prosemirror-keymap');
var prosemirrorCommands = require('prosemirror-commands');
var katex = require('katex');
var prosemirrorModel = require('prosemirror-model');
var prosemirrorInputrules = require('prosemirror-inputrules');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var katex__default = /*#__PURE__*/_interopDefaultLegacy(katex);

/**
 * A ProseMirror command for determining whether to exit a math block, based on
 * specific conditions.  Normally called when the user has
 *
 * @param outerView The main ProseMirror EditorView containing this math node.
 * @param dir Used to indicate desired cursor position upon closing a math node.
 *     When set to -1, cursor will be placed BEFORE the math node.
 *     When set to +1, cursor will be placed AFTER the math node.
 * @param borderMode An exit condition based on cursor position and direction.
 * @param requireEmptySelection When TRUE, only exit the math node when the
 *    (inner) selection is empty.
 * @returns A new ProseMirror command based on the input configuration.
 */
function collapseMathCmd(outerView, dir, requireOnBorder, requireEmptySelection = true) {
    // create a new ProseMirror command based on the input conditions
    return (innerState, dispatch) => {
        // get selection info
        let outerState = outerView.state;
        let { to: outerTo, from: outerFrom } = outerState.selection;
        let { to: innerTo, from: innerFrom } = innerState.selection;
        // only exit math node when selection is empty
        if (requireEmptySelection && innerTo !== innerFrom) {
            return false;
        }
        let currentPos = (dir > 0) ? innerTo : innerFrom;
        // when requireOnBorder is TRUE, collapse only when cursor
        // is about to leave the bounds of the math node
        if (requireOnBorder) {
            // (subtract two from nodeSize to account for start and end tokens)
            let nodeSize = innerState.doc.nodeSize - 2;
            // early return if exit conditions not met
            if (dir > 0 && currentPos < nodeSize) {
                return false;
            }
            if (dir < 0 && currentPos > 0) {
                return false;
            }
        }
        // all exit conditions met, so close the math node by moving the cursor outside
        if (dispatch) {
            // set outer selection to be outside of the nodeview
            let targetPos = (dir > 0) ? outerTo : outerFrom;
            outerView.dispatch(outerState.tr.setSelection(prosemirrorState.TextSelection.create(outerState.doc, targetPos)));
            // must return focus to the outer view, otherwise no cursor will appear
            outerView.focus();
        }
        return true;
    };
}

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/
class MathView {
    // == Lifecycle ===================================== //
    /**
     * @param onDestroy Callback for when this NodeView is destroyed.
     *     This NodeView should unregister itself from the list of ICursorPosObservers.
     *
     * Math Views support the following options:
     * @option displayMode If TRUE, will render math in display mode, otherwise in inline mode.
     * @option tagName HTML tag name to use for this NodeView.  If none is provided,
     *     will use the node name with underscores converted to hyphens.
     */
    constructor(node, view, getPos, options = {}, onDestroy) {
        // store arguments
        this._node = node;
        this._outerView = view;
        this._getPos = getPos;
        this._onDestroy = onDestroy && onDestroy.bind(this);
        // editing state
        this.cursorSide = "start";
        this._isEditing = false;
        // options
        this._katexOptions = Object.assign({ globalGroup: true, throwOnError: false }, options.katexOptions);
        this._tagName = options.tagName || this._node.type.name.replace("_", "-");
        // create dom representation of nodeview
        this.dom = document.createElement(this._tagName);
        this.dom.classList.add("math-node");
        this._mathRenderElt = document.createElement("span");
        this._mathRenderElt.textContent = "";
        this._mathRenderElt.classList.add("math-render");
        this.dom.appendChild(this._mathRenderElt);
        this._mathSrcElt = document.createElement("span");
        this._mathSrcElt.classList.add("math-src");
        this.dom.appendChild(this._mathSrcElt);
        // ensure 
        this.dom.addEventListener("click", () => this.ensureFocus());
        // render initial content
        this.renderMath();
    }
    destroy() {
        // close the inner editor without rendering
        this.closeEditor(false);
        // clean up dom elements
        if (this._mathRenderElt) {
            this._mathRenderElt.remove();
            delete this._mathRenderElt;
        }
        if (this._mathSrcElt) {
            this._mathSrcElt.remove();
            delete this._mathSrcElt;
        }
        this.dom.remove();
    }
    /**
     * Ensure focus on the inner editor whenever this node has focus.
     * This helps to prevent accidental deletions of math blocks.
     */
    ensureFocus() {
        if (this._innerView && this._outerView.hasFocus()) {
            this._innerView.focus();
        }
    }
    // == Updates ======================================= //
    update(node, decorations) {
        if (!node.sameMarkup(this._node))
            return false;
        this._node = node;
        if (this._innerView) {
            let state = this._innerView.state;
            let start = node.content.findDiffStart(state.doc.content);
            if (start != null) {
                let diff = node.content.findDiffEnd(state.doc.content);
                if (diff) {
                    let { a: endA, b: endB } = diff;
                    let overlap = start - Math.min(endA, endB);
                    if (overlap > 0) {
                        endA += overlap;
                        endB += overlap;
                    }
                    this._innerView.dispatch(state.tr
                        .replace(start, endB, node.slice(start, endA))
                        .setMeta("fromOutside", true));
                }
            }
        }
        if (!this._isEditing) {
            this.renderMath();
        }
        return true;
    }
    updateCursorPos(state) {
        const pos = this._getPos();
        const size = this._node.nodeSize;
        const inPmSelection = (state.selection.from < pos + size)
            && (pos < state.selection.to);
        if (!inPmSelection) {
            this.cursorSide = (pos < state.selection.from) ? "end" : "start";
        }
    }
    // == Events ===================================== //
    selectNode() {
        this.dom.classList.add("ProseMirror-selectednode");
        if (!this._isEditing) {
            this.openEditor();
        }
    }
    deselectNode() {
        this.dom.classList.remove("ProseMirror-selectednode");
        if (this._isEditing) {
            this.closeEditor();
        }
    }
    stopEvent(event) {
        return (this._innerView !== undefined)
            && (event.target !== undefined)
            && this._innerView.dom.contains(event.target);
    }
    ignoreMutation() { return true; }
    // == Rendering ===================================== //
    renderMath() {
        if (!this._mathRenderElt) {
            return;
        }
        // get tex string to render
        let content = this._node.content.content;
        let texString = "";
        if (content.length > 0 && content[0].textContent !== null) {
            texString = content[0].textContent.trim();
        }
        // empty math?
        if (texString.length < 1) {
            this.dom.classList.add("empty-math");
            // clear rendered math, since this node is in an invalid state
            while (this._mathRenderElt.firstChild) {
                this._mathRenderElt.firstChild.remove();
            }
            // do not render empty math
            return;
        }
        else {
            this.dom.classList.remove("empty-math");
        }
        // render katex, but fail gracefully
        try {
            katex__default['default'].render(texString, this._mathRenderElt, this._katexOptions);
            this._mathRenderElt.classList.remove("parse-error");
            this.dom.setAttribute("title", "");
        }
        catch (err) {
            if (err instanceof katex.ParseError) {
                console.error(err);
                this._mathRenderElt.classList.add("parse-error");
                this.dom.setAttribute("title", err.toString());
            }
            else {
                throw err;
            }
        }
    }
    // == Inner Editor ================================== //
    dispatchInner(tr) {
        if (!this._innerView) {
            return;
        }
        let { state, transactions } = this._innerView.state.applyTransaction(tr);
        this._innerView.updateState(state);
        if (!tr.getMeta("fromOutside")) {
            let outerTr = this._outerView.state.tr, offsetMap = prosemirrorTransform.StepMap.offset(this._getPos() + 1);
            for (let i = 0; i < transactions.length; i++) {
                let steps = transactions[i].steps;
                for (let j = 0; j < steps.length; j++) {
                    let mapped = steps[j].map(offsetMap);
                    if (!mapped) {
                        throw Error("step discarded!");
                    }
                    outerTr.step(mapped);
                }
            }
            if (outerTr.docChanged)
                this._outerView.dispatch(outerTr);
        }
    }
    openEditor() {
        if (this._innerView) {
            throw Error("inner view should not exist!");
        }
        // create a nested ProseMirror view
        this._innerView = new prosemirrorView.EditorView(this._mathSrcElt, {
            state: prosemirrorState.EditorState.create({
                doc: this._node,
                plugins: [prosemirrorKeymap.keymap({
                        "Tab": (state, dispatch) => {
                            if (dispatch) {
                                dispatch(state.tr.insertText("\t"));
                            }
                            return true;
                        },
                        "Backspace": prosemirrorCommands.chainCommands(prosemirrorCommands.deleteSelection, (state, dispatch, tr_inner) => {
                            // default backspace behavior for non-empty selections
                            if (!state.selection.empty) {
                                return false;
                            }
                            // default backspace behavior when math node is non-empty
                            if (this._node.textContent.length > 0) {
                                return false;
                            }
                            // otherwise, we want to delete the empty math node and focus the outer view
                            this._outerView.dispatch(this._outerView.state.tr.insertText(""));
                            this._outerView.focus();
                            return true;
                        }),
                        "Enter": prosemirrorCommands.newlineInCode,
                        "Ctrl-Enter": collapseMathCmd(this._outerView, +1, false),
                        "ArrowLeft": collapseMathCmd(this._outerView, -1, true),
                        "ArrowRight": collapseMathCmd(this._outerView, +1, true),
                        "ArrowUp": collapseMathCmd(this._outerView, -1, true),
                        "ArrowDown": collapseMathCmd(this._outerView, +1, true),
                    })]
            }),
            dispatchTransaction: this.dispatchInner.bind(this)
        });
        // focus element
        let innerState = this._innerView.state;
        this._innerView.focus();
        // determine cursor position
        let pos = (this.cursorSide == "start") ? 0 : this._node.nodeSize - 2;
        this._innerView.dispatch(innerState.tr.setSelection(prosemirrorState.TextSelection.create(innerState.doc, pos)));
        this._isEditing = true;
    }
    /**
     * Called when the inner ProseMirror editor should close.
     *
     * @param render Optionally update the rendered math after closing. (which
     *    is generally what we want to do, since the user is done editing!)
     */
    closeEditor(render = true) {
        if (this._innerView) {
            this._innerView.destroy();
            this._innerView = undefined;
        }
        if (render) {
            this.renderMath();
        }
        this._isEditing = false;
    }
}

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/
/**
 * Returns a function suitable for passing as a field in `EditorProps.nodeViews`.
 * @param displayMode TRUE for block math, FALSE for inline math.
 * @see https://prosemirror.net/docs/ref/#view.EditorProps.nodeViews
 */
function createMathView(displayMode) {
    return (node, view, getPos) => {
        /** @todo is this necessary?
        * Docs says that for any function proprs, the current plugin instance
        * will be bound to `this`.  However, the typings don't reflect this.
        */
        let pluginState = mathPluginKey.getState(view.state);
        if (!pluginState) {
            throw new Error("no math plugin!");
        }
        let nodeViews = pluginState.activeNodeViews;
        // set up NodeView
        let nodeView = new MathView(node, view, getPos, { katexOptions: { displayMode, macros: pluginState.macros } }, () => { nodeViews.splice(nodeViews.indexOf(nodeView)); });
        nodeViews.push(nodeView);
        return nodeView;
    };
}
let mathPluginKey = new prosemirrorState.PluginKey("prosemirror-math");
let mathPluginSpec = {
    key: mathPluginKey,
    state: {
        init(config, instance) {
            return {
                macros: {},
                activeNodeViews: []
            };
        },
        apply(tr, value, oldState, newState) {
            /** @todo (8/21/20)
             * since new state has not been fully applied yet, we don't yet have
             * information about any new MathViews that were created by this transaction.
             * As a result, the cursor position may be wrong for any newly created math blocks.
             */
            let pluginState = mathPluginKey.getState(oldState);
            if (pluginState) {
                for (let mathView of pluginState.activeNodeViews) {
                    mathView.updateCursorPos(newState);
                }
            }
            return value;
        },
        /** @todo (8/21/20) implement serialization for math plugin */
        // toJSON(value) { },
        // fromJSON(config, value, state){ return {}; }
    },
    props: {
        nodeViews: {
            "math_inline": createMathView(false),
            "math_display": createMathView(true)
        }
    }
};
const mathPlugin = new prosemirrorState.Plugin(mathPluginSpec);

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/
////////////////////////////////////////////////////////////
const editorSchema = new prosemirrorModel.Schema({
    nodes: {
        // :: NodeSpec top-level document node
        doc: {
            content: "block+"
        },
        paragraph: {
            content: "inline*",
            group: "block",
            parseDOM: [{ tag: "p" }],
            toDOM() { return ["p", 0]; }
        },
        math_inline: {
            group: "inline math",
            content: "text*",
            inline: true,
            atom: true,
            toDOM: () => ["math-inline", { class: "math-node" }, 0],
            parseDOM: [{
                    tag: "math-inline"
                }]
        },
        math_display: {
            group: "block math",
            content: "text*",
            atom: true,
            code: true,
            toDOM: () => ["math-display", { class: "math-node" }, 0],
            parseDOM: [{
                    tag: "math-display"
                }]
        },
        text: {
            group: "inline"
        }
    },
    marks: {
        math_select: {
            toDOM() { return ["math-select", 0]; },
            parseDOM: [{ tag: "math-select" }]
        }
    }
});

const mathBackspace = (state, dispatch) => {
    // check node before
    let { $from } = state.selection;
    let nodeBefore = $from.nodeBefore;
    if (!nodeBefore) {
        return false;
    }
    if (nodeBefore.type.name == "math_inline") {
        // select math node
        let index = $from.index($from.depth);
        let $beforePos = state.doc.resolve($from.posAtIndex(index - 1));
        if (dispatch) {
            dispatch(state.tr.setSelection(new prosemirrorState.NodeSelection($beforePos)));
        }
        return true;
    }
    else if (nodeBefore.type.name == "math_block") {
        /** @todo (8/1/20) implement backspace for math blocks
         * check how code blocks behave when pressing backspace
         */
        return false;
    }
    return false;
};

function inlineInputRule(pattern, nodeType, getAttrs) {
    return new prosemirrorInputrules.InputRule(pattern, (state, match, start, end) => {
        let $start = state.doc.resolve(start);
        let index = $start.index();
        let $end = state.doc.resolve(end);
        // get attrs
        let attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs;
        // check if replacement valid
        if (!$start.parent.canReplaceWith(index, $end.index(), nodeType)) {
            return null;
        }
        // perform replacement
        return state.tr.replaceRangeWith(start, end, nodeType.create(attrs, nodeType.schema.text(match[1])));
    });
}
function blockInputRule(pattern, nodeType, getAttrs) {
    return new prosemirrorInputrules.InputRule(pattern, (state, match, start, end) => {
        let $start = state.doc.resolve(start);
        let attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs;
        if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType))
            return null;
        let tr = state.tr
            .delete(start, end)
            .setBlockType(start, start, nodeType, attrs);
        return tr.setSelection(prosemirrorState.NodeSelection.create(tr.doc, tr.mapping.map($start.pos - 1)));
    });
}
const mathInputRules = prosemirrorInputrules.inputRules({
    rules: [
        // negative lookbehind regex notation for escaped \$ delimiters
        // (see https://javascript.info/regexp-lookahead-lookbehind)
        inlineInputRule(/(?<!\\)\$(.+)(?<!\\)\$/, editorSchema.nodes.math_inline),
        // simpler version without the option to escape \$
        //inlineInputRule(/\$(.+)\$/, editorSchema.nodes.math_inline),
        blockInputRule(/^\$\$\s+$/, editorSchema.nodes.math_display)
    ]
});

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/
////////////////////////////////////////////////////////////
/**
 * Uses the selection to determine which math_select decorations
 * should be applied to the given document.
 * @param arg Should be either a Transaction or an EditorState,
 *     although any object with `selection` and `doc` will work.
 */
let checkSelection = (arg) => {
    let { from, to } = arg.selection;
    let content = arg.selection.content().content;
    let result = [];
    content.descendants((node, pos, parent) => {
        if (node.type.name == "text") {
            return false;
        }
        if (node.type.name.startsWith("math_")) {
            result.push({
                start: Math.max(from + pos - 1, 0),
                end: from + pos + node.nodeSize - 1
            });
            return false;
        }
        return true;
    });
    return prosemirrorView.DecorationSet.create(arg.doc, result.map(({ start, end }) => prosemirrorView.Decoration.node(start, end, { class: "math-select" })));
};
/**
 * Due to the internals of KaTeX, by default, selecting rendered
 * math will put a box around each individual character of a
 * math expression.  This plugin attempts to make math selections
 * slightly prettier by instead setting a background color on the node.
 *
 * (remember to use the included math.css!)
 *
 * @todo (6/13/20) math selection rectangles are not quite even with text
 */
const mathSelectPlugin = new prosemirrorState.Plugin({
    state: {
        init(config, partialState) {
            return checkSelection(partialState);
        },
        apply(tr, oldState) {
            if (!tr.selection || !tr.selectionSet) {
                return oldState;
            }
            let sel = checkSelection(tr);
            return sel;
        }
    },
    props: {
        decorations: (state) => { return mathSelectPlugin.getState(state); },
    }
});

var mathSelect = /*#__PURE__*/Object.freeze({
	__proto__: null,
	'default': mathSelectPlugin
});

exports.MathView = MathView;
exports.editorSchema = editorSchema;
exports.mathBackspace = mathBackspace;
exports.mathInputRules = mathInputRules;
exports.mathPlugin = mathPlugin;
exports.mathSelectPlugin = mathSelect;
//# sourceMappingURL=index.js.map
