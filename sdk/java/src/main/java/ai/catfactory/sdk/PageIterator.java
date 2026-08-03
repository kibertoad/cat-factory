// Hand-written (NOT generated): the keyset auto-pagination the generated pagers build on.

package ai.catfactory.sdk;

import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import org.jspecify.annotations.Nullable;

/**
 * Lazily walks a keyset-paginated list, following {@code nextCursor} until the server reports no
 * further page.
 *
 * <p>An {@link Iterator} rather than a {@link java.util.stream.Stream}: each page is fetched
 * lazily and each fetch can fail, and a stream whose {@code next} throws mid-terminal-operation is
 * far harder to reason about than an explicit loop. Kotlin gets {@code for (item in …)} from an
 * Iterator with no adapter.
 *
 * <p>Iteration ends on the CURSOR, never on an empty page: a page may legitimately arrive empty
 * while a cursor is still set, and stopping there would silently truncate the walk.
 *
 * @param <T> the item type of the list being paged
 */
public abstract class PageIterator<T> implements Iterator<T> {


    /**
     * One page: its items and the cursor to the next, or null when this was the last.
     *
     * <p>Public because the generated resource clients live in a sibling package and construct it
     * from their {@code fetch} override.
     */
    public record Page<T>(List<T> items, @Nullable String nextCursor) {}

    private Iterator<T> current = Collections.emptyIterator();
    private @Nullable String cursor;
    private boolean exhausted;

    /** Fetch the page at {@code cursor} (null for the first). */
    protected abstract Page<T> fetch(@Nullable String cursor);

    @Override
    public boolean hasNext() {
        while (!current.hasNext() && !exhausted) {
            String requested = cursor;
            Page<T> page = fetch(cursor);
            current = page.items().iterator();
            cursor = page.nextCursor();
            if (cursor == null || cursor.isEmpty()) {
                exhausted = true;
            } else if (cursor.equals(requested)) {
                // The server answered a page with the SAME cursor it was given. That is a server
                // fault, and following it would never terminate — one page re-fetched forever
                // against the caller's rate limit. Thrown rather than treated as the end of the
                // walk, because a silent stop is indistinguishable from a completed one, and a
                // caller acting on "these are all the tasks" having seen one page is worse.
                throw new CatFactoryPaginationException(
                        "cat-factory SDK: the server repeated a pagination cursor; stopping rather"
                                + " than looping forever.");
            }
        }
        return current.hasNext();
    }

    @Override
    public T next() {
        if (!hasNext()) {
            throw new NoSuchElementException();
        }
        return current.next();
    }
}
