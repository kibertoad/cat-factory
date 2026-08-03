// Hand-written (NOT generated).

package ai.catfactory.sdk;

import org.jspecify.annotations.Nullable;

/**
 * A 2xx response whose body was not the JSON the contract promises — in practice a proxy or
 * gateway answering in the deployment's place.
 *
 * <p>The raw text is retained, because "invalid JSON" on its own does not tell you that something
 * in front of the backend returned an HTML error page.
 */
public final class CatFactoryDecodeException extends CatFactoryException {
    private final String rawBody;

    public CatFactoryDecodeException(String message, String rawBody, @Nullable Throwable cause) {
        super(message, cause);
        this.rawBody = rawBody;
    }

    /** The body exactly as received. */
    public String rawBody() {
        return rawBody;
    }
}
