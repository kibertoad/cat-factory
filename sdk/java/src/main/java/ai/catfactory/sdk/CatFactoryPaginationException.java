// Hand-written (NOT generated).

package ai.catfactory.sdk;

/**
 * An auto-pager was answered with the SAME {@code nextCursor} it had just sent.
 *
 * <p>That is a server fault, and {@link PageIterator} stops rather than following it — the walk
 * would otherwise never terminate, re-fetching one page forever against the caller's rate limit.
 * Thrown rather than treated as the end of the list because a silent stop is indistinguishable
 * from a completed walk, and a caller acting on "these are all the tasks" when they have seen one
 * page is the worse failure.
 */
public final class CatFactoryPaginationException extends CatFactoryException {
    public CatFactoryPaginationException(String message) {
        super(message, null);
    }
}
