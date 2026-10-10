// Hand-written (NOT generated).

package ai.catfactory.sdk;

import org.jspecify.annotations.Nullable;

/** The request never produced an HTTP response: DNS, TCP, TLS, or a dropped socket. */
public final class CatFactoryConnectionException extends CatFactoryException {
    public CatFactoryConnectionException(String message, @Nullable Throwable cause) {
        super(message, cause);
    }
}
