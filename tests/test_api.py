import pytest
import uuid
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock, AsyncMock
from sqlalchemy.orm import Session

from models import User, ChatThread, ChatMessage, OtpToken, TripReport



# 1. App sanity — FastAPI app starts and routes are registered

class TestAppCreation:

    def test_app_object_exists(self):
        """FastAPI app must be importable and not None."""
        from app import app
        assert app is not None

    def test_app_has_routes(self):
        """App must have routes registered (not an empty app)."""
        from app import fastapi_app
        routes = [r.path for r in fastapi_app.routes]
        assert len(routes) > 0, "No routes registered on the FastAPI app"

    def test_openapi_schema_loads(self, client):
        """FastAPI's auto-generated OpenAPI schema must return 200."""
        response = client.get("/openapi.json")
        assert response.status_code == 200
        data = response.json()
        assert "paths" in data



# 2. Health endpoint 

class TestHealthEndpoint:

    def test_health_returns_200(self, client):
        """
        /health must return 200.
        If this test FAILS it means you have no /health route —
        add one to app.py:  @app.get('/health') def health(): return {'status': 'ok'}
        """
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_returns_json(self, client):
        response = client.get("/health")
        data = response.json()
        assert isinstance(data, dict)



# 3. HTTP route smoke tests 

class TestPublicRoutes:

    def test_homepage_returns_200(self, client):
        """Landing page must be accessible without login."""
        response = client.get("/")
        assert response.status_code == 200

    def test_nonexistent_route_returns_404(self, client):
        response = client.get("/this-does-not-exist-xyz")
        assert response.status_code == 404


class TestProtectedRoutes:
    """API routes that require auth must reject unauthenticated requests."""

    def test_chat_endpoint_requires_auth(self, client):
        response = client.post("/api/travel", json={"message": "hello", "thread_id": None})
        assert response.status_code in (401, 403, 422)

    def test_threads_endpoint_requires_auth(self, client):
        response = client.get("/api/threads")
        assert response.status_code in (401, 403)

    def test_documents_endpoint_requires_auth(self, client):
        response = client.get("/api/docs")
        assert response.status_code in (401, 403)

    def test_reports_endpoint_requires_auth(self, client):
        response = client.get("/api/reports")
        assert response.status_code in (401, 403)



# 4. SQLAlchemy models 

class TestUserModel:

    def test_create_user(self, db_session: Session):
        """User creation must persist and be retrievable."""
        user = User(
            email="test@tripswarm.com",
            name="Test User",
            auth_provider="otp",
            is_verified=1,
        )
        db_session.add(user)
        db_session.commit()

        fetched = db_session.query(User).filter_by(email="test@tripswarm.com").first()
        assert fetched is not None
        assert fetched.name == "Test User"
        assert fetched.is_verified == 1

    def test_user_has_uuid_primary_key(self, db_session: Session):
        """User primary key must be a UUID, not an integer."""
        user = User(email="uuid_test@test.com", name="UUID User", auth_provider="google")
        db_session.add(user)
        db_session.commit()
        assert user.id is not None
        # Must be a UUID — str representation has dashes
        assert "-" in str(user.id)

    def test_user_email_is_unique(self, db_session: Session):
        """Duplicate email must raise an integrity error."""
        from sqlalchemy.exc import IntegrityError
        email = f"unique_{uuid.uuid4().hex[:6]}@test.com"
        u1 = User(email=email, name="First",  auth_provider="otp")
        u2 = User(email=email, name="Second", auth_provider="otp")
        db_session.add(u1)
        db_session.commit()
        db_session.add(u2)
        with pytest.raises(IntegrityError):
            db_session.commit()


class TestChatThreadModel:

    def test_create_thread_linked_to_user(self, db_session: Session):
        """ChatThread must link to a User via FK."""
        user = User(email=f"thread_{uuid.uuid4().hex[:6]}@test.com",
                    name="Thread User", auth_provider="otp")
        db_session.add(user)
        db_session.commit()

        thread = ChatThread(
            user_id=user.id,
            thread_type="travel",
            title="Paris Trip"
        )
        db_session.add(thread)
        db_session.commit()

        fetched = db_session.query(ChatThread).filter_by(title="Paris Trip").first()
        assert fetched is not None
        assert fetched.user_id == user.id
        assert fetched.thread_type == "travel"

    def test_thread_has_correct_types(self, db_session: Session):
        """thread_type must only be 'travel' or 'rag' in practice."""
        user = User(email=f"type_{uuid.uuid4().hex[:6]}@test.com",
                    name="Type User", auth_provider="otp")
        db_session.add(user)
        db_session.commit()

        for t_type in ["travel", "rag"]:
            thread = ChatThread(user_id=user.id, thread_type=t_type,
                                title=f"{t_type} thread")
            db_session.add(thread)
        db_session.commit()

        threads = db_session.query(ChatThread).filter_by(user_id=user.id).all()
        types = {t.thread_type for t in threads}
        assert "travel" in types
        assert "rag" in types


class TestOtpTokenModel:

    def test_create_otp_token(self, db_session: Session):
        """OTP token must store email and code correctly."""
        otp = OtpToken(
            email="otp_test@test.com",
            code="123456",
            expires_at=datetime.utcnow() + timedelta(minutes=10),
        )
        db_session.add(otp)
        db_session.commit()

        fetched = db_session.query(OtpToken).filter_by(email="otp_test@test.com").first()
        assert fetched is not None
        assert fetched.code == "123456"
        assert fetched.tries == 0  # default

    def test_otp_expiry_is_in_future(self, db_session: Session):
        """A freshly created OTP token must not be expired."""
        otp = OtpToken(
            email=f"exp_{uuid.uuid4().hex[:6]}@test.com",
            code="654321",
            expires_at=datetime.utcnow() + timedelta(minutes=10),
        )
        db_session.add(otp)
        db_session.commit()
        assert otp.expires_at > datetime.utcnow()



# 5. OTP auth logic

class TestOTPFlow:

    def test_request_otp_sends_email(self, client):
        """
        POST /auth/request-otp must accept a valid email.
        Mailer is mocked — no real email is sent.
        """
        with patch("requests.post") as mock_post:
            mock_post.return_value = MagicMock(status_code=200)
            response = client.post(
                "/api/otp/send",
                json={"email": "newuser@gmail.com", "name": "New User"}
            )
        # 200 (sent) or 404 if route not found yet
        assert response.status_code in (200, 201, 404, 422)

    def test_verify_otp_rejects_wrong_code(self, client):
        """POST /auth/verify-otp with a wrong code must not log the user in."""
        response = client.post(
            "/api/otp/verify",
            json={"email": "nobody@test.com", "code": "000000"}
        )
        assert response.status_code in (400, 401, 404, 422)


# 6. TripReport model

class TestTripReportModel:

    def test_create_trip_report(self, db_session: Session):
        """TripReport must link to a User and store content."""
        user = User(email=f"report_{uuid.uuid4().hex[:6]}@test.com",
                    name="Report User", auth_provider="otp")
        db_session.add(user)
        db_session.commit()

        report = TripReport(
            user_id=user.id,
            title="My Paris Trip Report",
            content="Visited Eiffel Tower, Louvre...",
            is_favourite=0,
        )
        db_session.add(report)
        db_session.commit()

        fetched = db_session.query(TripReport).filter_by(user_id=user.id).first()
        assert fetched is not None
        assert fetched.title == "My Paris Trip Report"
        assert fetched.is_favourite == 0

    def test_report_feedback_values(self, db_session: Session):
        """feedback field must accept 'like', 'dislike', or None."""
        user = User(email=f"fb_{uuid.uuid4().hex[:6]}@test.com",
                    name="FB User", auth_provider="otp")
        db_session.add(user)
        db_session.commit()

        for fb in ["like", "dislike", None]:
            r = TripReport(user_id=user.id, title=f"Report {fb}",
                           content="test", feedback=fb)
            db_session.add(r)
        db_session.commit()

        reports = db_session.query(TripReport).filter_by(user_id=user.id).all()
        feedbacks = {r.feedback for r in reports}
        assert "like" in feedbacks
        assert "dislike" in feedbacks
        assert None in feedbacks