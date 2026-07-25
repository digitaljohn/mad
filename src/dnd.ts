// dataTransfer types used for the app's own drags.
//
// These live apart from the modules that use them so the file tree doesn't have
// to import the editor — that import pulled Milkdown, ProseMirror and Mermaid
// into anything touching the tree, including its tests.

/** An image dragged out of the sidebar, to be inserted into the document. */
export const TREE_IMAGE_DND = "application/x-mad-image";
/** A tree row dragged to move it between folders. */
export const TREE_MOVE_DND = "application/x-mad-move";
/** A tab dragged along the strip to reorder it. */
export const TAB_DND = "application/x-mad-tab";
