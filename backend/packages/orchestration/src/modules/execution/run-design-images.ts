// ---------------------------------------------------------------------------
// What a BUILDING kind's half of a task's pictures costs, and therefore how much of it a dispatch
// gets. The set itself is resolved in `run-images.ts`, from the one read both consumers share.
// ---------------------------------------------------------------------------

/**
 * How many design pictures one dispatch may put in front of its model.
 *
 * Far tighter than the capture ceiling (`MAX_REFERENCE_SCREENSHOTS`), and for a different currency: a capture pays
 * for each image ONCE, in container transfer time, while an attachment pays for it on EVERY turn of
 * the run, in input tokens the model re-reads each time. A design system's frame list is unbounded
 * from here (a task can link a whole file), so an uncapped set would quietly turn a long coding loop
 * into one whose context is mostly pictures.
 *
 * Six is what a screen's worth of work looks like: the view being built plus the states and
 * neighbours it has to match. A run needing more of the design has the textual layout for the rest,
 * which is the same fallback a text-only model gets.
 */
export const MAX_DESIGN_IMAGES = 6
