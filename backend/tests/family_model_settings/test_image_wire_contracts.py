import base64
import json
from dataclasses import replace
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace

import pytest

from app.ai.images.generation import (
    DashScopeImageGenerationProvider,
    ImageGenerationClient,
    ImageGenerationProviderOutcomeUncertain,
    ImageGenerationRequest,
    ImageProviderDependencies,
    build_ai_image_prompt,
)
from app.core.enums import ImageGenerationMode, MediaEntityType
from app.services.family_model_settings.capability_tests import _run_http_probe
from app.services.family_model_settings.errors import FamilyModelEndpointBlocked
from app.services.family_model_settings.probe_contracts import REFERENCE_IMAGE, probe_response_detail
from app.services.family_model_settings.transport import ProviderMedia, ProviderResponse
from app.services.family_model_settings.types import DispatchCredential
from app.services.model_usage.errors import ModelUsageContractError
from tests.family_model_settings.test_family_image_runtime import _binding


PNG = base64.b64decode(REFERENCE_IMAGE.split(',', 1)[1])


def parse_multipart(headers, body):
    assert headers['Content-Type'].startswith('multipart/form-data; boundary=')
    message = BytesParser(policy=default).parsebytes(
        f"Content-Type: {headers['Content-Type']}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body,
    )
    assert message.is_multipart() and not message.defects
    return {part.get_param('name', header='Content-Disposition'): part for part in message.iter_parts()}


class Attempt:
    def __init__(self, timeline):
        self.timeline = timeline
        self.dispatch_permit = None

    def prepare_dispatch(self):
        self.timeline.append('dispatch')
        self.dispatch_permit = SimpleNamespace(credential_secret_version_id='image-secret', provider_idempotency_key='image-attempt')
        return self.dispatch_permit

    def settle(self, receipt):
        self.timeline.append('settle')
        return SimpleNamespace(event_id='image-usage')

    def mark_uncertain(self, code):
        self.timeline.append('uncertain')


def test_reference_runtime_sends_standard_multipart_after_permit_and_credential_resolution():
    binding = _binding(family_id='family-a', variant='reference')
    timeline = []
    request = ImageGenerationRequest(entity_type=MediaEntityType.FOOD, mode=ImageGenerationMode.REFERENCE,
        title='番茄炒蛋', reference_image_bytes=PNG, reference_filename='tomato.png', size='1536*1152')

    def send(method, url, *, headers, body=None, json=None):
        timeline.append('send')
        assert method == 'POST' and url.endswith('/images/edits') and json is None
        assert headers['Authorization'] == 'Bearer synthetic-key'
        assert headers['Idempotency-Key'] == 'image-attempt'
        parts = parse_multipart(headers, body)
        assert set(parts) == {'model', 'prompt', 'n', 'size', 'output_format', 'image[]'}
        assert parts['model'].get_content() == binding.requested_model
        assert parts['prompt'].get_payload(decode=True).decode('utf-8') == build_ai_image_prompt(request)
        assert parts['size'].get_content() == '1536x1024'
        assert parts['n'].get_content() == '1'
        assert parts['image[]'].get_filename() == 'tomato.png'
        assert parts['image[]'].get_content_type() == 'image/png'
        assert parts['image[]'].get_payload(decode=True) == PNG
        return ProviderResponse(200, {}, b'{"data":[{"b64_json":"' + base64.b64encode(PNG) + b'"}]}')

    def credential(resolved, secret):
        assert resolved is binding and secret == 'image-secret'
        timeline.append('credential')
        return DispatchCredential('family-a', binding.provider_profile_id, secret, 'synthetic-key')

    client = ImageGenerationClient.for_binding(binding, dependencies=ImageProviderDependencies(
        SimpleNamespace(request=send), credential,
    ))
    with pytest.raises(ModelUsageContractError, match='image_dispatch_permit_required'):
        client.generate_from_reference(request)
    assert timeline == []
    adapter = SimpleNamespace(model=binding.requested_model, receipt_from_provider_success=lambda *args, **kwargs: 'receipt')
    result = client.generate(request, usage_attempt=Attempt(timeline), usage_adapter=adapter)
    assert result.image.binary_content == PNG
    assert timeline == ['dispatch', 'credential', 'send', 'settle']


def test_reference_probe_uploads_same_valid_image_file_and_no_private_json_fields():
    binding = _binding(family_id='family-a', variant='reference')
    calls = []

    def send(method, url, *, headers, body, **kwargs):
        assert not kwargs
        calls.append(url)
        parts = parse_multipart(headers, body)
        assert set(parts) == {'model', 'prompt', 'n', 'size', 'output_format', 'image[]'}
        assert parts['image[]'].get_payload(decode=True) == PNG
        assert parts['image[]'].get_content_type() == 'image/png'
        assert parts['size'].get_content() == '1536x1024'
        return ProviderResponse(200, {}, b'{}')

    _run_http_probe(binding=binding, permit=SimpleNamespace(provider_idempotency_key=None),
        credential=DispatchCredential('family-a', binding.provider_profile_id, None, 'synthetic-key'),
        transport=SimpleNamespace(request=send))
    assert len(calls) == 1 and calls[0].endswith('/images/edits')


@pytest.mark.parametrize('adapter', ['openai_compatible_http', 'dashscope'])
@pytest.mark.parametrize('outcome', ['valid', 'invalid_bytes', 'blocked'])
def test_image_probe_downloads_and_decodes_media_before_success(adapter, outcome):
    binding = replace(_binding(family_id='family-a'), adapter_kind=adapter)
    url = 'https://family-a.provider.example/result.png?Signature=fake'
    data = {'data': [{'url': url}]} if adapter == 'openai_compatible_http' else {
        'output': {'choices': [{'message': {'content': [{'image': url}]}}]},
    }
    response = ProviderResponse(200, {}, json.dumps(data).encode())
    calls = []

    def download(actual, *, source, adapter_kind):
        assert actual == url and source is binding.endpoint and adapter_kind == adapter
        calls.append(actual)
        if outcome == 'blocked':
            raise FamilyModelEndpointBlocked()
        return ProviderMedia(PNG if outcome == 'valid' else b'invalid-image', 'image/png', source)

    if outcome == 'valid':
        assert '下载有效图片' in probe_response_detail(binding, response, SimpleNamespace(download_media=download))
    else:
        with pytest.raises(Exception):
            probe_response_detail(binding, response, SimpleNamespace(download_media=download))
    assert calls == [url]
    with pytest.raises(ValueError, match='image_download_not_verified'):
        probe_response_detail(binding, response)


def test_dashscope_download_failure_keeps_uncertain_resend_barrier():
    binding = replace(_binding(family_id='family-a'), adapter_kind='dashscope')
    timeline = []

    def send(*args, **kwargs):
        timeline.append('send')
        return ProviderResponse(200, {}, b'{"output":{"choices":[{"message":{"content":[{"image":"https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/image.png?Signature=fake"}]}}]}}')

    def download(*args, **kwargs):
        timeline.append('download')
        raise FamilyModelEndpointBlocked()

    client = ImageGenerationClient.for_binding(binding, dependencies=ImageProviderDependencies(
        SimpleNamespace(request=send, download_media=download),
        lambda resolved, secret: DispatchCredential('family-a', resolved.provider_profile_id, secret, 'synthetic-key'),
    ))
    assert isinstance(client.text_provider, DashScopeImageGenerationProvider)
    with pytest.raises(ImageGenerationProviderOutcomeUncertain):
        client.generate(ImageGenerationRequest(entity_type=MediaEntityType.FOOD, mode=ImageGenerationMode.TEXT),
            usage_attempt=Attempt(timeline), usage_adapter=SimpleNamespace(model=binding.requested_model))
    assert timeline == ['dispatch', 'send', 'download', 'uncertain']
