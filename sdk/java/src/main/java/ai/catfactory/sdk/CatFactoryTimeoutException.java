// Hand-written (NOT generated).

package ai.catfactory.sdk;

import org.jspecify.annotations.Nullable;

/**
 * The request exceeded the client-side deadline, so no verdict was reached.
 *
 * <p>Kept apart from {@link CatFactoryConnectionException} because the two need different
 * reactions: a timeout may succeed with a longer budget, an unreachable host will not.
 */
public final class CatFactoryTimeoutException extends CatFactoryException {
    public CatFactoryTimeoutException(String message, @Nullable Throwable cause) {
        super(message, cause);
    }
}
