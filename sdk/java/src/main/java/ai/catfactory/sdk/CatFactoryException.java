// Hand-written (NOT generated): the SDK's failure vocabulary.

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Base class for everything this SDK throws, so one {@code catch} bounds the whole client.
 *
 * <p><b>Unchecked, always.</b> Kotlin has no checked exceptions, so a {@code throws IOException}
 * on this surface would be invisible to a Kotlin caller while forcing ceremony on the Java one.
 * Every failure here extends {@link RuntimeException}.
 *
 * <p><b>Sealed hierarchy.</b> The subclasses are a closed set, so a Kotlin caller can write an
 * exhaustive {@code when} over the failure kinds — and a Java 21 caller the same {@code switch}
 * pattern — instead of testing status codes by hand. That is one of the reasons this artifact
 * serves Kotlin without a second, Kotlin-native SDK existing.
 */
public sealed class CatFactoryException extends RuntimeException
        permits CatFactoryConnectionException,
                CatFactoryTimeoutException,
                CatFactoryDecodeException,
                CatFactoryApiException {

    CatFactoryException(String message, @Nullable Throwable cause) {
        super(message, cause);
    }
}
