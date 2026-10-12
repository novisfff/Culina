from copy import deepcopy

import pytest

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api
from tests.family_model_settings.test_validation import _save_draft, _validate
from tests.family_model_settings.test_capability_tests import _usage_event_count_for_capability
from tests.ai_audio.test_cosyvoice_protocol import CosyVoiceSocket
from tests.ai_audio.test_realtime_protocols import StrictSocket
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.subjects import ensure_user_subject


def audio_payload(profile_id, capability, model, output_format='mp3'):
    meters = ['audio_input_seconds', 'tts_characters'] if capability == 'realtime_audio' else ['tts_characters']
    return {
        'bindings': [{
            'capability': capability, 'variant_key': 'default', 'enabled': True,
            'provider_profile_id': profile_id, 'requested_model': model,
            **({'output_format': output_format} if capability == 'tts' else {}),
        }],
        'price_rates': [{
            'capability': capability, 'variant_key': 'default', 'meter': meter,
            'unit_quantity': '1000', 'unit_price': '0.01', 'source_currency': 'CNY', 'fx_to_cny': '1',
        } for meter in meters],
        'change_note': '原生语音模型协议校验',
    }


@pytest.mark.parametrize('model', ['qwen3-tts-flash-realtime', 'qwen3-asr-flash-realtime', 'cosyvoice-v3-plus'])
def test_tts_only_and_asr_only_models_cannot_publish_as_native_duplex(family_model_api: FamilyModelApiContext, model):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    _save_draft(family_model_api, audio_payload(profile['id'], 'realtime_audio', model))
    result = _validate(family_model_api)
    assert not result.valid
    assert any(issue.code == 'family_model_realtime_model_unsupported' and issue.field == 'bindings.0.requested_model' for issue in result.errors)
    settings = family_model_api.client.get('/api/family/model-settings').json()
    assert settings.get('active_config_revision_id') is None
    assert not family_model_api.transport.calls and not family_model_api.transport.websocket_calls


@pytest.mark.parametrize('model', ['qwen-omni-turbo-realtime', 'qwen3-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.8-omni-flash-realtime'])
def test_native_omni_families_remain_configurable(family_model_api: FamilyModelApiContext, model):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    _save_draft(family_model_api, audio_payload(profile['id'], 'realtime_audio', model))
    assert _validate(family_model_api).valid


@pytest.mark.parametrize('output_format', ['mp3', 'wav', 'flac', 'ogg', 'mp4'])
def test_cosyvoice_only_publishes_supported_audio_formats(family_model_api: FamilyModelApiContext, output_format):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    _save_draft(family_model_api, audio_payload(profile['id'], 'tts', 'cosyvoice-v3-plus', output_format))
    result = _validate(family_model_api)
    assert result.valid == (output_format in {'mp3', 'wav'})
    if not result.valid:
        assert any(issue.code == 'family_model_audio_output_format_unsupported' for issue in result.errors)


def test_invalid_realtime_model_edit_preserves_the_active_omni_binding(family_model_api: FamilyModelApiContext):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    payload = audio_payload(profile['id'], 'realtime_audio', 'qwen3-omni-flash-realtime')
    first = _save_draft(family_model_api, payload)
    active_before = family_model_api.client.get('/api/family/model-settings').json()['active_config_revision_id']
    assert active_before is not None
    invalid = deepcopy(payload)
    invalid['bindings'][0]['requested_model'] = 'qwen3-tts-flash-realtime'
    _save_draft(family_model_api, invalid, base_draft_version_number=first['draft_version_number'], idempotency_key='invalid-native-duplex-edit')
    assert not _validate(family_model_api).valid
    assert family_model_api.client.get('/api/family/model-settings').json()['active_config_revision_id'] == active_before


@pytest.mark.parametrize('capability', ['tts', 'realtime_audio'])
def test_native_audio_capability_api_settles_once_and_replay_never_sends_again(family_model_api, monkeypatch, capability):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    model = 'cosyvoice-v3-plus' if capability == 'tts' else 'qwen3-omni-flash-realtime'
    _save_draft(family_model_api, audio_payload(profile['id'], capability, model, 'wav'))
    with family_model_api.session_factory() as db:
        subject = ensure_user_subject(db, family_id='family-a', user_id='owner-a')
        ensure_family_model_usage_defaults(db, family_id='family-a', creator_subject_id=subject.id)
        db.commit()
    sockets = []

    def connect(transport, url, *, headers):
        assert url.startswith('wss://dashscope.aliyuncs.com/api-ws/v1/')
        socket = CosyVoiceSocket() if capability == 'tts' else StrictSocket('dashscope')
        sockets.append(socket)
        transport.websocket_calls.append((url, dict(headers)))
        return socket

    monkeypatch.setattr(type(family_model_api.transport), 'connect_websocket', connect)
    payload = {'variant_key': 'default', 'confirm_billable': True, 'idempotency_key': 'native-audio-test'}
    url = f'/api/family/model-settings/capabilities/{capability}/test'
    first = family_model_api.client.post(url, json=payload)
    second = family_model_api.client.post(url, json=payload)
    assert first.status_code == second.status_code == 200, first.text
    assert first.json()['status'] == second.json()['status'] == 'succeeded'
    if capability == 'tts':
        assert first.json()['audio_preview_data_url'].startswith('data:audio/wav;base64,')
        assert second.json().get('audio_preview_data_url') is None
    assert _usage_event_count_for_capability(family_model_api, capability) == 1
    assert len(sockets) == (1 if capability == 'tts' else 2)
    assert all(socket.closed for socket in sockets)
    assert not family_model_api.transport.calls


def test_cosyvoice_api_failure_retains_uncertain_attempt_and_blocks_replay(family_model_api, monkeypatch):
    profile = family_model_api.create_profile(adapter_kind='dashscope')
    _save_draft(family_model_api, audio_payload(profile['id'], 'tts', 'cosyvoice-v3-plus', 'wav'))
    with family_model_api.session_factory() as db:
        subject = ensure_user_subject(db, family_id='family-a', user_id='owner-a')
        ensure_family_model_usage_defaults(db, family_id='family-a', creator_subject_id=subject.id)
        db.commit()
    sockets = []

    def connect(transport, url, *, headers):
        socket = CosyVoiceSocket(failure='task_failed')
        sockets.append(socket)
        transport.websocket_calls.append((url, dict(headers)))
        return socket

    monkeypatch.setattr(type(family_model_api.transport), 'connect_websocket', connect)
    payload = {'variant_key': 'default', 'confirm_billable': True, 'idempotency_key': 'native-audio-failed-test'}
    url = '/api/family/model-settings/capabilities/tts/test'
    first = family_model_api.client.post(url, json=payload)
    second = family_model_api.client.post(url, json=payload)
    assert first.status_code == 503 and second.status_code == 409
    assert second.json()['detail']['code'] == 'family_model_operation_in_progress'
    assert _usage_event_count_for_capability(family_model_api, 'tts') == 0
    assert len(sockets) == 1 and sockets[0].closed
